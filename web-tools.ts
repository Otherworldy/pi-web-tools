/**
 * pi-web-tools — body
 *
 * Tools: one_search, web_fetch, get_search_content, source_check.
 * Commands: /web-tools, /search, /curator, /websearch, /activity.
 *
 * API key resolution precedence per search source (first wins):
 *   1. Source environment variable (e.g. BRAVE_SEARCH_API_KEY, TAVILY_API_KEY)
 *   2. search.sources[source].apiKey field in the Pi agent extension config file
 *   3. (Brave only, legacy migration) apiKey field in config.json
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { activityMonitor } from "./activity.js";
import {
	buildResearchArtifact,
	withClaimAssessment,
	storeResearchArtifact,
	type RecencyFilter,
} from "./source-check.js";
import {
	generateId,
	getAllResults,
	getResult,
	sliceText,
	storeResult,
	STORAGE_CUSTOM_TYPE,
	type ExtractedContent,
} from "./storage.js";
import { getConfigPath, readConfig, validateGuidanceFields, type WebToolsConfig, writeConfig } from "./providers/config.js";
import { domainPolicyFromConfig, extractUrl, ssrfFromConfig } from "./providers/extract.js";
import { createSearchProvider } from "./providers/factory.js";
import { PROVIDERS } from "./providers/index.js";
import { GITHUB_TOKEN_ENV_VAR, getActiveGitHubInterceptor, getInterceptors } from "./providers/interceptors/index.js";
import { validateRemoteUrl } from "./providers/ssrf.js";
import type {
	FullProvider,
	ProviderMeta,
	SearchProvider,
	SearchResponse,
	SearchResult,
} from "./providers/types.js";

// ---------------------------------------------------------------------------
// Tunables and external surface
// ---------------------------------------------------------------------------

const MIN_SEARCH_RESULTS = 1;
const DEFAULT_SOURCE_RESULTS = 10;
const DEFAULT_MERGED_RESULTS = 20;

const SEARCH_RESULT_PREVIEW_LIMIT = 5;
const FETCH_PREVIEW_LINE_LIMIT = 15;
const API_KEY_MASK_VISIBLE_CHARS = 4;

const FETCH_TEMP_DIR_PREFIX = "pi-web-tools-fetch-";
const FETCH_TEMP_FILE_NAME = "content.txt";
const DEFAULT_CONTENT_SLICE = 30_000;
const INCLUDE_CONTENT_CAP = 5;
const SOURCE_CHECK_FETCH_CAP = 5;
const SOURCE_CHECK_SOURCE_CAP = 20;

const CONFIG_PATH = getConfigPath();

const WEB_TOOLS_COMMAND_NAME = "web-tools";
const SHOW_COMMAND = "show";
const DEFAULT_RESULTS_COMMAND = "default-results";
const MERGED_RESULTS_COMMAND = "merged-results";
const SOURCE_RESULTS_COMMAND = "source-results";
const SOURCE_ENABLE_COMMAND = "source-enable";
const SOURCE_DISABLE_COMMAND = "source-disable";
const UNSET_LABEL = "(not set)";

// Brave is the only provider whose key was historically stored at the top
// level (config.apiKey) before the multi-source search.sources map. The legacy
// field is auto-migrated to search.sources.brave.apiKey by the config reader.
const LEGACY_TOP_LEVEL_KEY_PROVIDER = "brave";

// ---------------------------------------------------------------------------
// Config persistence — schema + reader/writer live in providers/config.ts.
// The two local aliases keep the call-site shape identical to pre-refactor
// (loadConfig / saveConfig) so the rest of this file reads unchanged.
// ---------------------------------------------------------------------------

const loadConfig = readConfig;
const saveConfig = writeConfig;

// ---------------------------------------------------------------------------
// Executor guidance — overrides + defaults
// ---------------------------------------------------------------------------

export const DEFAULT_WEB_SEARCH_SNIPPET = "Search the web for up-to-date information";
export const DEFAULT_WEB_SEARCH_GUIDELINES: string[] = [
	"Use one_search for information beyond your training data — recent events, current library versions, live API documentation.",
	"one_search queries all enabled/configured search sources concurrently (or a single provider when provider= is set), then merges and de-duplicates results by URL.",
	"Optional params: queries (batch), recencyFilter (day|week|month|year), domainFilter (include or -exclude), includeContent, provider, workflow (none|auto-summary).",
	"search.defaultResults controls the per-source request count; search.mergedResults controls the default final merged result count.",
	"Only pass max_results when the user explicitly asks for a specific final result count; otherwise omit it so the configured search.mergedResults is used.",
	'Use the current year from "Current date:" in your context when searching for recent information or documentation.',
	'After answering using search results, include a "Sources:" section listing relevant URLs as markdown hyperlinks: [Title](URL). Never skip this.',
	"Use get_search_content with the returned responseId to page through stored results/content.",
	"Use source_check to verify a claim with passage-level citations.",
	"If no search source is enabled/configured, ask the user to run /web-tools before proceeding.",
];

export const DEFAULT_WEB_FETCH_SNIPPET = "Fetch and read content from a specific URL";
export const DEFAULT_WEB_FETCH_GUIDELINES: string[] = [
	"Use web_fetch to read the full content of a specific URL or urls[] batch — documentation pages, blog posts, API references found via one_search.",
	"web_fetch is complementary to one_search: search finds URLs, fetch reads them. PDFs are text-extracted and saved under ~/Downloads.",
	"For GitHub repository URLs above the clone size threshold, pass forceClone: true only after the user confirms they want a full clone.",
	'After answering using fetched content, include a "Sources:" section with a markdown hyperlink to the fetched URL.',
	"Large responses are truncated and spilled to a temp file — the temp path is reported in the result details. Prefer get_search_content for stored full bodies.",
];

// ---------------------------------------------------------------------------
// API key resolution + masking
// ---------------------------------------------------------------------------

function resolveProviderApiKey(providerName: string, config: WebToolsConfig): string | undefined {
	const meta = PROVIDERS.find((p) => p.name === providerName);
	if (!meta) return undefined;

	const envKey = meta.envVar ? process.env[meta.envVar]?.trim() : undefined;
	if (envKey) return envKey;

	const sourceKey = config.search?.sources?.[providerName]?.apiKey?.trim();
	if (sourceKey) return sourceKey;

	const legacyConfigKey = config.apiKeys?.[providerName]?.trim();
	if (legacyConfigKey) return legacyConfigKey;

	if (providerName === LEGACY_TOP_LEVEL_KEY_PROVIDER) {
		return config.apiKey?.trim() || undefined;
	}

	return undefined;
}

// Generic per-source base-URL resolution: env → search.sources[name].baseUrl →
// legacy baseUrls[name] → meta.defaultBaseUrl → "". Providers without
// baseUrlEnvVar short-circuit to "". The orchestrator only calls this for
// providers that declare baseUrlEnvVar, so the empty-string fallback is a
// safety net rather than a runtime path.
function resolveProviderBaseUrl(meta: ProviderMeta, config: WebToolsConfig): string {
	if (!meta.baseUrlEnvVar) return "";
	const envUrl = process.env[meta.baseUrlEnvVar]?.trim();
	if (envUrl) return envUrl;
	const sourceUrl = config.search?.sources?.[meta.name]?.baseUrl?.trim();
	if (sourceUrl) return sourceUrl;
	const legacyConfigUrl = config.baseUrls?.[meta.name]?.trim();
	if (legacyConfigUrl) return legacyConfigUrl;
	return meta.defaultBaseUrl ?? "";
}

function maskApiKey(key: string | undefined): string {
	if (!key) return UNSET_LABEL;
	const head = key.slice(0, API_KEY_MASK_VISIBLE_CHARS);
	const tail = key.slice(-API_KEY_MASK_VISIBLE_CHARS);
	return `${head}...${tail}`;
}

function normalizeResultCount(requested: number | undefined, defaultValue: number): number {
	const value = requested ?? defaultValue;
	if (!Number.isFinite(value)) return defaultValue;
	const integer = Math.trunc(value);
	return integer >= MIN_SEARCH_RESULTS ? integer : defaultValue;
}

function getDefaultSourceResultLimit(config: WebToolsConfig): number {
	return normalizeResultCount(config.search?.defaultResults ?? config.defaultSearchResults, DEFAULT_SOURCE_RESULTS);
}

function getMergedResultLimit(config: WebToolsConfig): number {
	return normalizeResultCount(config.search?.mergedResults, DEFAULT_MERGED_RESULTS);
}

function getSourceResultLimit(config: WebToolsConfig, providerName: string): number {
	const source = config.search?.sources?.[providerName];
	return normalizeResultCount(source?.resultLimit ?? source?.defaultResults, getDefaultSourceResultLimit(config));
}

function resolveMergedResultLimit(
	requested: number | undefined,
	config: WebToolsConfig,
	providerNames: string[] = [],
): number {
	const configuredMergedResultLimit = getMergedResultLimit(config);
	if (requested !== undefined) return normalizeResultCount(requested, configuredMergedResultLimit);
	if (providerNames.length === 1) {
		return Math.max(configuredMergedResultLimit, getSourceResultLimit(config, providerNames[0]));
	}
	return configuredMergedResultLimit;
}

function buildSourceResultLimits(config: WebToolsConfig, providerNames: string[]): Record<string, number> {
	return Object.fromEntries(providerNames.map((providerName) => [providerName, getSourceResultLimit(config, providerName)]));
}

function parsePositiveIntegerArg(args: string, command: string, label: string): number | undefined {
	const trimmed = args.trim();
	const [currentCommand, rawValue] = trimmed.split(/\s+/, 2);
	if (currentCommand !== command) return undefined;
	if (!rawValue) throw new Error(`Usage: /${WEB_TOOLS_COMMAND_NAME} ${command} <positive-integer>`);
	const parsed = Number(rawValue);
	if (!Number.isInteger(parsed) || parsed < MIN_SEARCH_RESULTS) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return parsed;
}

function getCommandName(args: string): string {
	return args.trim().split(/\s+/, 1)[0] ?? "";
}

function parseProviderNameArg(args: string, command: string): string | undefined {
	const trimmed = args.trim();
	const [currentCommand, rawProviderName, extra] = trimmed.split(/\s+/, 3);
	if (currentCommand !== command) return undefined;
	if (!rawProviderName || extra) {
		throw new Error(`Usage: /${WEB_TOOLS_COMMAND_NAME} ${command} <source>`);
	}
	const providerName = rawProviderName.toLowerCase();
	if (!PROVIDERS.some((provider) => provider.name === providerName)) {
		throw new Error(`Unknown search source: ${rawProviderName}`);
	}
	return providerName;
}

function parseSourceResultsArg(args: string): { providerName: string; resultLimit: number } | undefined {
	const trimmed = args.trim();
	const [command, rawProviderName, rawValue] = trimmed.split(/\s+/, 3);
	if (command !== SOURCE_RESULTS_COMMAND) return undefined;
	if (!rawProviderName || !rawValue) {
		throw new Error(`Usage: /${WEB_TOOLS_COMMAND_NAME} ${SOURCE_RESULTS_COMMAND} <source> <positive-integer>`);
	}
	const providerName = rawProviderName.toLowerCase();
	if (!PROVIDERS.some((provider) => provider.name === providerName)) {
		throw new Error(`Unknown search source: ${rawProviderName}`);
	}
	const parsed = Number(rawValue);
	if (!Number.isInteger(parsed) || parsed < MIN_SEARCH_RESULTS) {
		throw new Error("Source result count must be a positive integer.");
	}
	return { providerName, resultLimit: parsed };
}

function isSourceDisabled(config: WebToolsConfig, providerName: string): boolean {
	return config.search?.sources?.[providerName]?.enabled === false;
}

function sourceHasExplicitEnable(config: WebToolsConfig, providerName: string): boolean {
	return config.search?.sources?.[providerName]?.enabled === true;
}

function isConfiguredSearchProvider(meta: ProviderMeta, config: WebToolsConfig): boolean {
	if (!meta.roles.includes("search")) return false;
	if (isSourceDisabled(config, meta.name)) return false;
	const apiKey = resolveProviderApiKey(meta.name, config);
	if (!meta.baseUrlEnvVar) return apiKey !== undefined;
	return Boolean(
		sourceHasExplicitEnable(config, meta.name) ||
		apiKey ||
		process.env[meta.baseUrlEnvVar]?.trim() ||
		config.search?.sources?.[meta.name]?.baseUrl?.trim() ||
		config.baseUrls?.[meta.name]?.trim(),
	);
}

function instantiateSearchProviders(
	config: WebToolsConfig,
): Array<{ providerName: string; provider: SearchProvider | FullProvider }> {
	const configuredMetas = PROVIDERS.filter((meta) => isConfiguredSearchProvider(meta, config));

	return configuredMetas.map((meta) => {
		const apiKey = resolveProviderApiKey(meta.name, config);
		const baseUrl = meta.baseUrlEnvVar ? resolveProviderBaseUrl(meta, config) : undefined;
		return {
			providerName: meta.name,
			provider: createSearchProvider(meta.name, { apiKey: apiKey ?? "", baseUrl }),
		};
	});
}

function instantiateFetchProviders(config: WebToolsConfig): FullProvider[] {
	return PROVIDERS.filter((meta) => meta.roles.includes("fetch") && isConfiguredSearchProvider(meta, config))
		.map((meta) => {
			const apiKey = resolveProviderApiKey(meta.name, config);
			const baseUrl = meta.baseUrlEnvVar ? resolveProviderBaseUrl(meta, config) : undefined;
			return createSearchProvider(meta.name, { apiKey: apiKey ?? "", baseUrl });
		})
		.filter((provider): provider is FullProvider => "fetch" in provider);
}

function searchableProviderLabels(providers: Array<{ provider: SearchProvider | FullProvider }>): string {
	return providers.map(({ provider }) => provider.label).join(", ");
}

function normalizeResultUrl(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) return "";
	try {
		const parsed = new URL(trimmed);
		parsed.hash = "";
		parsed.hostname = parsed.hostname.toLowerCase();
		if (parsed.pathname !== "/") parsed.pathname = parsed.pathname.replace(/\/+$/, "");
		return parsed.toString();
	} catch {
		return trimmed.replace(/\/+$/, "").toLowerCase();
	}
}

function mergeSearchResponses(
	responses: Array<{ providerName: string; response: SearchResponse }>,
	maxResults: number,
): SearchResult[] {
	const seenUrls = new Set<string>();
	const merged: SearchResult[] = [];
	const cursors = new Array(responses.length).fill(0);

	while (merged.length < maxResults) {
		let addedThisRound = false;
		for (let responseIndex = 0; responseIndex < responses.length && merged.length < maxResults; responseIndex += 1) {
			const { providerName, response } = responses[responseIndex];
			while (cursors[responseIndex] < response.results.length) {
				const result = response.results[cursors[responseIndex]];
				cursors[responseIndex] += 1;
				const key = normalizeResultUrl(result.url);
				if (key && seenUrls.has(key)) continue;
				if (key) seenUrls.add(key);
				merged.push({ ...result, source: result.source ?? providerName });
				addedThisRound = true;
				break;
			}
		}
		if (!addedThisRound) break;
	}
	return merged;
}

function formatSourceFailures(failures: Array<{ providerName: string; reason: unknown }>): string[] {
	return failures.map(({ providerName, reason }) => {
		const message = reason instanceof Error ? reason.message : String(reason);
		return `${providerName}: ${message}`;
	});
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error("Search cancelled");
}

// ---------------------------------------------------------------------------
// URL guard (SSRF) + search helpers
// ---------------------------------------------------------------------------

async function assertFetchableHttpUrl(raw: string, config: WebToolsConfig): Promise<URL> {
	const ssrf = ssrfFromConfig(config);
	return validateRemoteUrl(raw, {
		allowRanges: ssrf.allowRanges,
		trustEnvProxy: ssrf.trustEnvProxy,
		domainPolicy: domainPolicyFromConfig(config),
	});
}

const RECENCY_SUFFIX: Record<RecencyFilter, string> = {
	day: " past day",
	week: " past week",
	month: " past month",
	year: " past year",
};

function applyRecency(query: string, recency?: RecencyFilter): string {
	if (!recency) return query;
	return `${query}${RECENCY_SUFFIX[recency] ?? ""}`;
}

function applyDomainFilter(results: SearchResult[], domainFilter?: string[]): SearchResult[] {
	if (!domainFilter?.length) return results;
	const include = domainFilter.filter((d) => !d.startsWith("-")).map((d) => d.toLowerCase());
	const exclude = domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1).toLowerCase());
	return results.filter((r) => {
		let host = "";
		try {
			host = new URL(r.url).hostname.toLowerCase();
		} catch {
			return false;
		}
		if (exclude.some((d) => host === d || host.endsWith(`.${d}`))) return false;
		if (include.length === 0) return true;
		return include.some((d) => host === d || host.endsWith(`.${d}`));
	});
}

function buildDeterministicSummary(query: string, results: SearchResult[]): string {
	if (results.length === 0) return `No results for "${query}".`;
	const lines = [`Summary for "${query}" (${results.length} sources):`];
	for (const r of results.slice(0, 8)) {
		lines.push(`- ${r.title}: ${r.snippet}`.trim());
	}
	return lines.join("\n");
}

function persistStored(pi: ExtensionAPI | undefined, data: Parameters<typeof storeResult>[1]): void {
	storeResult(data.id, data);
	try {
		pi?.appendEntry?.(STORAGE_CUSTOM_TYPE, data);
	} catch {
		// session persistence is best-effort
	}
}

function extractOptionsFromConfig(config: WebToolsConfig) {
	const ssrf = ssrfFromConfig(config);
	return {
		ssrf,
		domainPolicy: domainPolicyFromConfig(config),
		fetchProviders: instantiateFetchProviders(config),
		jinaApiKey: resolveProviderApiKey("jina", config),
	};
}

// ---------------------------------------------------------------------------
// web_fetch helpers
// ---------------------------------------------------------------------------

interface FetchDetails {
	url: string;
	title?: string;
	contentType?: string;
	contentLength?: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

interface WebFetchParams {
	url?: string;
	urls?: string[];
	raw?: boolean;
	forceClone?: boolean;
}

interface OneSearchParams {
	query?: string;
	queries?: string[];
	max_results?: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
	provider?: string;
	includeContent?: boolean;
	workflow?: "none" | "auto-summary";
}

interface SearchProgress {
	completed: number;
	total: number;
	message: string;
}

interface SearchProgressDetails {
	progress?: SearchProgress;
}

const SEARCH_PROGRESS_BAR_WIDTH = 6;

function formatSearchProgressBar(completed: number, total: number): string {
	const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
	const filled = Math.round(ratio * SEARCH_PROGRESS_BAR_WIDTH);
	return `[${"█".repeat(filled)}${" ".repeat(SEARCH_PROGRESS_BAR_WIDTH - filled)}] ${completed}/${total}`;
}

function emitSearchProgress(
	onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	completed: number,
	total: number,
	message: string,
): void {
	const progress = { completed, total, message };
	onUpdate?.({
		content: [{ type: "text", text: `${message} ${formatSearchProgressBar(completed, total)}` }],
		details: { progress },
	});
}

async function spillFullContentToTempFile(content: string): Promise<string> {
	const tempDir = await mkdtemp(join(tmpdir(), FETCH_TEMP_DIR_PREFIX));
	const tempFile = join(tempDir, FETCH_TEMP_FILE_NAME);
	await writeFile(tempFile, content, "utf8");
	return tempFile;
}

function formatTruncationFooter(truncation: TruncationResult, tempFile: string): string {
	const truncatedLines = truncation.totalLines - truncation.outputLines;
	const truncatedBytes = truncation.totalBytes - truncation.outputBytes;
	return (
		`\n\n[Content truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
		` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).` +
		` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.` +
		` Full content saved to: ${tempFile}]`
	);
}

function formatFetchHeader(url: string, title: string | undefined, contentType: string): string {
	const lines = [`**Fetched:** ${url}`];
	if (title) lines.push(`**Title:** ${title}`);
	if (contentType) lines.push(`**Content-Type:** ${contentType}`);
	return `${lines.join("\n")}\n\n`;
}

// ---------------------------------------------------------------------------
// one_search result rendering
// ---------------------------------------------------------------------------

function formatSourceResultCounts(
	sourceResultCounts: Record<string, number> | undefined,
	sourceResultLimits: Record<string, number> | undefined,
): string {
	const sourceNames = new Set([...Object.keys(sourceResultLimits ?? {}), ...Object.keys(sourceResultCounts ?? {})]);
	if (sourceNames.size === 0) return "";
	return Array.from(sourceNames)
		.map((source) => {
			const returned = sourceResultCounts?.[source] ?? 0;
			const requested = sourceResultLimits?.[source];
			return requested === undefined ? `${source}: ${returned}` : `${source}: ${returned}/${requested}`;
		})
		.join(", ");
}

function formatSearchResultsBody(response: {
	query: string;
	results: SearchResult[];
	failures?: string[];
	sourceResultCounts?: Record<string, number>;
	sourceResultLimits?: Record<string, number>;
	mergedResultLimit?: number;
}): string {
	let text = `**Search results for "${response.query}":**\n`;
	const sourceCounts = formatSourceResultCounts(response.sourceResultCounts, response.sourceResultLimits);
	if (sourceCounts) text += `**Source results:** ${sourceCounts}\n`;
	if (response.mergedResultLimit !== undefined) text += `**Merged result count:** ${response.mergedResultLimit}\n`;
	text += "\n";
	response.results.forEach((r, i) => {
		const source = r.source ? ` _(source: ${r.source})_` : "";
		text += `${i + 1}. **${r.title}**${source}\n   ${r.url}\n   ${r.snippet}\n\n`;
	});
	if (response.failures?.length) {
		text += "\n**Search source warnings:**\n";
		response.failures.forEach((failure) => {
			text += `- ${failure}\n`;
		});
	}
	return text.trimEnd();
}

function countResultsBySource(responses: Array<{ providerName: string; response: SearchResponse }>): Record<string, number> {
	return Object.fromEntries(responses.map(({ providerName, response }) => [providerName, response.results.length]));
}

function buildEmptyResultsEnvelope(
	query: string,
	providerNames: string[],
	failures: string[] = [],
	sourceResultCounts: Record<string, number> = {},
	sourceResultLimits: Record<string, number> = {},
	mergedResultLimit?: number,
) {
	return {
		content: [{ type: "text" as const, text: `No results found for "${query}".` }],
		details: {
			query,
			backend: providerNames.join(","),
			backends: providerNames,
			sourceResultLimits,
			sourceResultCounts,
			mergedResultLimit,
			resultCount: 0,
			failures,
		},
	};
}

// ---------------------------------------------------------------------------
// Tool registrars
// ---------------------------------------------------------------------------

export function registerWebSearchTool(pi: ExtensionAPI): void {
	const config = loadConfig();
	const guidance = validateGuidanceFields(config.guidance?.web_search);
	const defaultMergedResults = getMergedResultLimit(config);

	pi.registerTool({
		name: "one_search",
		label: "One Search",
		description:
			"Search the web for information. Returns a list of results with titles, URLs, and snippets. Use when you need current information not in your training data.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_WEB_SEARCH_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_WEB_SEARCH_GUIDELINES,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The search query. Be specific and use natural language.",
				},
				queries: {
					type: "array",
					items: { type: "string" },
					description: "Optional batch of queries. When set, each query is searched and results are merged.",
				},
				max_results: {
					type: "number",
					description: `Optional final merged result count. Omit unless the user explicitly asks for a specific count; omitted calls use configured search.mergedResults (${defaultMergedResults}). Per-source request counts are configured separately.`,
					minimum: MIN_SEARCH_RESULTS,
				},
				recencyFilter: {
					type: "string",
					enum: ["day", "week", "month", "year"],
					description: "Bias results toward the recent day/week/month/year.",
				},
				domainFilter: {
					type: "array",
					items: { type: "string" },
					description: "Limit to domains, or prefix with - to exclude (e.g. github.com, -example.com).",
				},
				provider: {
					type: "string",
					description: "Optional single search source name. Omit to query all enabled/configured sources.",
				},
				includeContent: {
					type: "boolean",
					description: "When true, fetch full page content for top sources (stored; use get_search_content to page).",
					default: false,
				},
				workflow: {
					type: "string",
					enum: ["none", "auto-summary"],
					description: "none returns raw results; auto-summary prepends a deterministic summary. Default from config.workflow or none.",
				},
			},
		},

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const p = params as OneSearchParams;
			const config = loadConfig();
			const queries = (p.queries?.length ? p.queries : p.query ? [p.query] : [])
				.map((q) => q.trim())
				.filter(Boolean);
			if (queries.length === 0) throw new Error("Provide query or queries.");

			let providers = instantiateSearchProviders(config);
			if (p.provider && p.provider !== "auto") {
				const wanted = p.provider.toLowerCase();
				providers = providers.filter(({ providerName }) => providerName === wanted);
				if (providers.length === 0) {
					throw new Error(`Search source "${p.provider}" is not enabled/configured.`);
				}
			}
			if (providers.length === 0) {
				throw new Error(`No search sources enabled/configured. Run /${WEB_TOOLS_COMMAND_NAME} to configure one or more sources.`);
			}

			const providerNames = providers.map(({ providerName }) => providerName);
			const mergedResultLimit = resolveMergedResultLimit(p.max_results, config, providerNames);
			const sourceResultLimits = buildSourceResultLimits(config, providerNames);
			const primaryQuery = queries[0];
			const workflow = p.workflow ?? config.workflow ?? "none";
			const totalSearches = queries.length * providers.length;
			let completedSearches = 0;

			emitSearchProgress(
				onUpdate,
				0,
				totalSearches,
				`Searching ${searchableProviderLabels(providers)} for: "${primaryQuery}"...`,
			);

			const queryDatas: Array<{
				query: string;
				results: SearchResult[];
				error: string | null;
				provider?: string;
				failures: string[];
				sourceResultCounts: Record<string, number>;
			}> = [];

			for (const rawQuery of queries) {
				const activityId = activityMonitor.logStart({ type: "api", query: rawQuery });
				const q = applyRecency(rawQuery, p.recencyFilter);
				try {
					const settled = await Promise.allSettled(
						providers.map(async ({ providerName, provider }) => {
							try {
								return {
									providerName,
									response: await provider.search(q, sourceResultLimits[providerName], signal),
								};
							} finally {
								completedSearches += 1;
								emitSearchProgress(
									onUpdate,
									completedSearches,
									totalSearches,
									`Searching ${providerName} for: "${rawQuery}"...`,
								);
							}
						}),
					);
					throwIfAborted(signal);
					const successfulResponses: Array<{ providerName: string; response: SearchResponse }> = [];
					const failedResponses: Array<{ providerName: string; reason: unknown }> = [];
					settled.forEach((result, index) => {
						if (result.status === "fulfilled") successfulResponses.push(result.value);
						else failedResponses.push({ providerName: providers[index].providerName, reason: result.reason });
					});
					const failures = formatSourceFailures(failedResponses);
					if (successfulResponses.length === 0) {
						activityMonitor.logError(activityId, failures.join("; "));
						queryDatas.push({
							query: rawQuery,
							results: [],
							error: failures.join("; "),
							failures,
							sourceResultCounts: {},
						});
						continue;
					}
					const sourceResultCounts = countResultsBySource(successfulResponses);
					let results = mergeSearchResponses(successfulResponses, mergedResultLimit);
					results = applyDomainFilter(results, p.domainFilter);
					activityMonitor.logComplete(activityId, 200);
					queryDatas.push({
						query: rawQuery,
						results,
						error: null,
						provider: providerNames.join(","),
						failures,
						sourceResultCounts,
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					activityMonitor.logError(activityId, message);
					queryDatas.push({ query: rawQuery, results: [], error: message, failures: [message], sourceResultCounts: {} });
				}
			}

			const allFailures = queryDatas.flatMap((q) => q.failures);
			const mergedAll = mergeSearchResponses(
				queryDatas.map((q) => ({ providerName: q.provider ?? "search", response: { query: q.query, results: q.results } })),
				mergedResultLimit,
			);
			const successfulQueryCount = queryDatas.filter((q) => q.error === null).length;
			if (successfulQueryCount === 0) {
				throw new Error(`All searches failed: ${allFailures.join("; ")}`);
			}

			let fetched: ExtractedContent[] = [];
			if (p.includeContent && mergedAll.length > 0) {
				const extractOpts = extractOptionsFromConfig(config);
				fetched = await Promise.all(
					mergedAll.slice(0, INCLUDE_CONTENT_CAP).map((r) =>
						extractUrl(r.url, { ...extractOpts, signal }),
					),
				);
			}

			const responseId = generateId();
			persistStored(pi, {
				id: responseId,
				type: "search",
				timestamp: Date.now(),
				queries: queryDatas.map((q) => ({
					query: q.query,
					results: q.results,
					error: q.error,
					provider: q.provider,
					answer: workflow === "auto-summary" ? buildDeterministicSummary(q.query, q.results) : undefined,
				})),
				urls: fetched.length ? fetched : undefined,
			});

			const sourceResultCounts = Object.assign({}, ...queryDatas.map((q) => q.sourceResultCounts));
			if (mergedAll.length === 0) {
				const empty = buildEmptyResultsEnvelope(
					primaryQuery,
					providerNames,
					allFailures,
					sourceResultCounts,
					sourceResultLimits,
					mergedResultLimit,
				);
				return {
					...empty,
					details: { ...empty.details, responseId },
				};
			}

			let text = formatSearchResultsBody({
				query: queries.length === 1 ? primaryQuery : `${queries.length} queries`,
				results: mergedAll,
				failures: allFailures,
				sourceResultCounts,
				sourceResultLimits,
				mergedResultLimit,
			});
			if (workflow === "auto-summary") {
				text = `${buildDeterministicSummary(primaryQuery, mergedAll)}\n\n${text}`;
			}
			text += `\n\n**responseId:** ${responseId}`;
			if (fetched.length) {
				text += `\n**Fetched content:** ${fetched.filter((f) => !f.error).length}/${fetched.length} pages (use get_search_content)`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					query: primaryQuery,
					queries,
					backend: providerNames.join(","),
					backends: providerNames,
					sourceResultLimits,
					sourceResultCounts,
					mergedResultLimit,
					resultCount: mergedAll.length,
					results: mergedAll,
					failures: allFailures,
					responseId,
					workflow,
				},
			};
		},

		renderCall(args, theme, _context) {
			const a = args as OneSearchParams;
			const queries = (a.queries?.length ? a.queries : a.query ? [a.query] : [])
				.map((q) => String(q).trim())
				.filter(Boolean);
			let text = theme.fg("toolTitle", theme.bold("WebSearch"));
			if (queries.length === 0) {
				// no-op
			} else if (queries.length === 1) {
				text += " " + theme.fg("accent", `"${queries[0]}"`);
			} else {
				text += theme.fg("muted", ` (${queries.length})`);
				for (const q of queries) {
					text += `\n  ${theme.fg("accent", `"${q}"`)}`;
				}
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				const progress = (result.details as SearchProgressDetails | undefined)?.progress;
				return new Text(
					theme.fg(
						"warning",
						progress
							? `${progress.message} ${formatSearchProgressBar(progress.completed, progress.total)}`
							: "Searching...",
					),
					0,
					0,
				);
			}
			const details = result.details as { resultCount?: number; results?: SearchResult[] };
			const count = details?.resultCount ?? 0;
			let text = theme.fg("success", `✓ ${count} result${count !== 1 ? "s" : ""}`);
			if (expanded && details?.results) {
				text += renderSearchResultsPreview(details.results, theme);
			}
			return new Text(text, 0, 0);
		},
	});
}

function renderSearchResultsPreview(results: SearchResult[], theme: Theme): string {
	let text = "";
	for (const r of results.slice(0, SEARCH_RESULT_PREVIEW_LIMIT)) {
		text += `\n  ${theme.fg("dim", `• ${r.title}`)}`;
	}
	if (results.length > SEARCH_RESULT_PREVIEW_LIMIT) {
		text += `\n  ${theme.fg("dim", `... and ${results.length - SEARCH_RESULT_PREVIEW_LIMIT} more`)}`;
	}
	return text;
}

async function fetchOneUrl(
	url: string,
	raw: boolean,
	forceClone: boolean,
	signal: AbortSignal | undefined,
	config: WebToolsConfig,
): Promise<{ bodyText: string; title?: string; contentType?: string; contentLength?: number; extracted: ExtractedContent }> {
	await assertFetchableHttpUrl(url, config);

	// GitHub interceptor first
	for (const interceptor of getInterceptors()) {
		const r = await interceptor.intercept(url, { raw, signal, forceClone });
		if (r) {
			return {
				bodyText: r.text,
				title: r.title,
				contentType: r.contentType,
				contentLength: r.contentLength,
				extracted: { url, title: r.title ?? "", content: r.text, error: null },
			};
		}
	}

	const extractOpts = extractOptionsFromConfig(config);
	const extracted = await extractUrl(url, { ...extractOpts, raw, signal });
	if (extracted.error && !extracted.content) {
		throw new Error(extracted.error);
	}
	return {
		bodyText: extracted.content,
		title: extracted.title || undefined,
		contentType: extracted.outputPath ? "text/markdown" : undefined,
		extracted,
	};
}

export function registerWebFetchTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance?.web_fetch);

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch the content of a specific URL (or urls batch). Returns text content for HTML pages, PDF text extraction, RSC-aware extraction, and fallbacks for blocked pages. Supports http and https only. Content is truncated to avoid overwhelming the context window.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_WEB_FETCH_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_WEB_FETCH_GUIDELINES,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "The URL to fetch. Must be http or https.",
				},
				urls: {
					type: "array",
					items: { type: "string" },
					description: "Optional batch of URLs to fetch.",
				},
				raw: {
					type: "boolean",
					description: "If true, return the raw HTML instead of extracted text. Default: false.",
					default: false,
				},
				forceClone: {
					type: "boolean",
					description:
						"For GitHub repository URLs only: force cloning even when the repo exceeds maxRepoSizeMB. Default: false.",
					default: false,
				},
			},
		},

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { url, urls, raw = false, forceClone = false } = params as WebFetchParams;
			const targets = (urls?.length ? urls : url ? [url] : []).map((u) => u.trim()).filter(Boolean);
			if (targets.length === 0) throw new Error("Provide url or urls.");

			onUpdate?.({
				content: [{ type: "text", text: targets.length === 1 ? `Fetching: ${targets[0]}...` : `Fetching ${targets.length} URLs...` }],
				details: { url: targets[0] } as FetchDetails,
			});

			const config = loadConfig();
			const extractedList: ExtractedContent[] = [];
			const parts: string[] = [];
			let lastDetails: FetchDetails = { url: targets[0] };

			for (const target of targets) {
				const { bodyText, title, contentType, contentLength, extracted } = await fetchOneUrl(
					target,
					raw,
					forceClone,
					signal,
					config,
				);
				extractedList.push(extracted);

				const truncation = truncateHead(bodyText, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});
				const details: FetchDetails = { url: target, title, contentType, contentLength };
				let output = truncation.content;
				if (truncation.truncated) {
					const tempFile = await spillFullContentToTempFile(bodyText);
					details.truncation = truncation;
					details.fullOutputPath = tempFile;
					output += formatTruncationFooter(truncation, tempFile);
				}
				lastDetails = details;
				parts.push(formatFetchHeader(target, title, contentType ?? "") + output);
			}

			const responseId = generateId();
			persistStored(pi, {
				id: responseId,
				type: "fetch",
				timestamp: Date.now(),
				urls: extractedList,
			});

			const text = `${parts.join("\n\n---\n\n")}\n\n**responseId:** ${responseId}`;
			return {
				content: [{ type: "text", text }],
				details: { ...lastDetails, responseId, urlCount: targets.length },
			};
		},

		renderCall(args, theme, _context) {
			const a = args as WebFetchParams;
			const urls = (a.urls?.length ? a.urls : a.url ? [a.url] : [])
				.map((u) => String(u).trim())
				.filter(Boolean);
			let text = theme.fg("toolTitle", theme.bold("WebFetch"));
			if (urls.length === 0) {
				// no-op
			} else if (urls.length === 1) {
				text += " " + theme.fg("accent", urls[0]);
			} else {
				text += theme.fg("muted", ` (${urls.length})`);
				for (const u of urls) {
					text += `\n  ${theme.fg("accent", u)}`;
				}
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}
			const details = result.details as FetchDetails | undefined;
			let text = theme.fg("success", "✓ Fetched");
			if (details?.title) text += theme.fg("muted", `: ${details.title}`);
			if (details?.truncation?.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					text += renderFetchedContentPreview(content.text, theme);
				}
			}
			return new Text(text, 0, 0);
		},
	});
}

export function registerGetSearchContentTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "get_search_content",
		label: "Get Search Content",
		description:
			"Retrieve stored content from previous one_search / web_fetch / source_check calls by responseId. Supports offset/limit paging.",
		parameters: {
			type: "object",
			properties: {
				responseId: { type: "string", description: "responseId returned by a previous tool call" },
				urlIndex: { type: "number", description: "Index into stored urls[]" },
				url: { type: "string", description: "Exact URL to retrieve from stored urls" },
				query: { type: "string", description: "Original query to retrieve from stored queries" },
				queryIndex: { type: "number", description: "Index into stored queries[]" },
				offset: { type: "number", description: "Character offset into content (default 0)" },
				limit: { type: "number", description: `Max characters to return (default ${DEFAULT_CONTENT_SLICE})` },
			},
			required: ["responseId"],
		},
		async execute(_id, params) {
			const responseId = String((params as { responseId: string }).responseId);
			const stored = getResult(responseId);
			if (!stored) throw new Error(`No stored result for responseId=${responseId}`);

			const p = params as {
				urlIndex?: number;
				url?: string;
				query?: string;
				queryIndex?: number;
				offset?: number;
				limit?: number;
			};
			const offset = p.offset ?? 0;
			const limit = p.limit ?? DEFAULT_CONTENT_SLICE;

			if (stored.type === "research") {
				const json = JSON.stringify(stored.artifact, null, 2);
				const page = sliceText(json, offset, limit);
				return {
					content: [{ type: "text", text: page.text + (page.hasMore ? `\n\n[hasMore offset=${page.offset + page.text.length} total=${page.total}]` : "") }],
					details: { responseId, type: stored.type, ...page },
				};
			}

			if (stored.urls?.length) {
				let pageContent = stored.urls[0];
				if (typeof p.urlIndex === "number") pageContent = stored.urls[p.urlIndex];
				else if (p.url) pageContent = stored.urls.find((u) => u.url === p.url) ?? pageContent;
				if (!pageContent) throw new Error("URL content not found in stored result");
				const page = sliceText(pageContent.content || pageContent.error || "", offset, limit);
				return {
					content: [
						{
							type: "text",
							text:
								`**URL:** ${pageContent.url}\n**Title:** ${pageContent.title}\n\n` +
								page.text +
								(page.hasMore ? `\n\n[hasMore offset=${page.offset + page.text.length} total=${page.total}]` : ""),
						},
					],
					details: { responseId, url: pageContent.url, ...page },
				};
			}

			if (stored.queries?.length) {
				let q = stored.queries[0];
				if (typeof p.queryIndex === "number") q = stored.queries[p.queryIndex];
				else if (p.query) q = stored.queries.find((item) => item.query === p.query) ?? q;
				const body = JSON.stringify(q, null, 2);
				const page = sliceText(body, offset, limit);
				return {
					content: [{ type: "text", text: page.text + (page.hasMore ? `\n\n[hasMore offset=${page.offset + page.text.length} total=${page.total}]` : "") }],
					details: { responseId, query: q.query, ...page },
				};
			}

			throw new Error("Stored result has no content");
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("GetContent ")) + theme.fg("accent", String((args as { responseId: string }).responseId)), 0, 0);
		},
		renderResult(_result, { isPartial }, theme) {
			return new Text(isPartial ? theme.fg("warning", "Loading...") : theme.fg("success", "✓ Content"), 0, 0);
		},
	});
}

export function registerSourceCheckTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "source_check",
		label: "Source Check",
		description:
			"Check a claim against web sources and return a machine-readable research artifact with passage citations.",
		parameters: {
			type: "object",
			properties: {
				claim: { type: "string", description: "Claim to verify" },
				queries: {
					type: "array",
					items: { type: "string" },
					description: "Optional search queries; defaults to the claim",
				},
				fetchContent: {
					type: "boolean",
					description: "Fetch up to 5 source pages for passage extraction",
					default: false,
				},
				domainFilter: {
					type: "array",
					items: { type: "string" },
					description: "Domain include/exclude filters (prefix - to exclude)",
				},
				recencyFilter: {
					type: "string",
					enum: ["day", "week", "month", "year"],
				},
			},
			required: ["claim"],
		},
		async execute(_id, params, signal, onUpdate) {
			const p = params as {
				claim: string;
				queries?: string[];
				fetchContent?: boolean;
				domainFilter?: string[];
				recencyFilter?: RecencyFilter;
			};
			const claim = p.claim.trim();
			if (!claim) throw new Error("claim is required");
			const queries = (p.queries?.length ? p.queries : [claim]).map((q) => q.trim()).filter(Boolean);
			const config = loadConfig();
			const providers = instantiateSearchProviders(config);
			if (providers.length === 0) {
				throw new Error(`No search sources enabled/configured. Run /${WEB_TOOLS_COMMAND_NAME} first.`);
			}

			const allResults: SearchResult[] = [];
			const errors: Array<{ query: string; error: string }> = [];
			const providerNames = providers.map((x) => x.providerName);
			const sourceResultLimits = buildSourceResultLimits(config, providerNames);
			const totalSearches = queries.length * providers.length;
			let completedSearches = 0;
			emitSearchProgress(onUpdate, 0, totalSearches, `Checking claim: "${claim}"...`);

			for (const rawQuery of queries) {
				const q = applyRecency(rawQuery, p.recencyFilter);
				const activityId = activityMonitor.logStart({ type: "api", query: `source_check: ${rawQuery}` });
				try {
					const settled = await Promise.allSettled(
						providers.map(async ({ providerName, provider }) => {
							try {
								return {
									providerName,
									response: await provider.search(q, sourceResultLimits[providerName], signal),
								};
							} finally {
								completedSearches += 1;
								emitSearchProgress(
									onUpdate,
									completedSearches,
									totalSearches,
									`Checking ${providerName} for: "${rawQuery}"...`,
								);
							}
						}),
					);
					const ok = settled
						.filter((r): r is PromiseFulfilledResult<{ providerName: string; response: SearchResponse }> => r.status === "fulfilled")
						.map((r) => r.value);
					if (ok.length === 0) {
						const msg = formatSourceFailures(
							settled
								.map((r, i) =>
									r.status === "rejected"
										? { providerName: providers[i].providerName, reason: r.reason }
										: null,
								)
								.filter(Boolean) as Array<{ providerName: string; reason: unknown }>,
						).join("; ");
						errors.push({ query: rawQuery, error: msg });
						activityMonitor.logError(activityId, msg);
						continue;
					}
					let merged = mergeSearchResponses(ok, SOURCE_CHECK_SOURCE_CAP);
					merged = applyDomainFilter(merged, p.domainFilter);
					allResults.push(...merged);
					activityMonitor.logComplete(activityId, 200);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					errors.push({ query: rawQuery, error: message });
					activityMonitor.logError(activityId, message);
				}
			}

			// dedupe + cap
			const seen = new Set<string>();
			const deduped: SearchResult[] = [];
			for (const r of allResults) {
				const key = normalizeResultUrl(r.url);
				if (!key || seen.has(key)) continue;
				seen.add(key);
				deduped.push(r);
				if (deduped.length >= SOURCE_CHECK_SOURCE_CAP) break;
			}

			let fetched: ExtractedContent[] = [];
			if (p.fetchContent && deduped.length > 0) {
				const extractOpts = extractOptionsFromConfig(config);
				fetched = await Promise.all(
					deduped.slice(0, SOURCE_CHECK_FETCH_CAP).map((r) => extractUrl(r.url, { ...extractOpts, signal })),
				);
			}

			let artifact = buildResearchArtifact({
				query: claim,
				provider: providerNames.join(","),
				results: deduped,
				fetched,
				recency: p.recencyFilter,
				domainFilter: p.domainFilter,
			});
			if (errors.length) artifact = { ...artifact, errors };
			artifact = withClaimAssessment(artifact, [claim]);
			storeResearchArtifact(artifact);
			persistStored(pi, {
				id: artifact.id,
				type: "research",
				timestamp: artifact.timestamp,
				artifact,
			});

			const assessment = artifact.claims?.[0];
			const text = [
				`**Claim:** ${claim}`,
				`**Status:** ${assessment?.status ?? "missing-evidence"} (confidence ${assessment?.confidence ?? 0})`,
				`**Rationale:** ${assessment?.rationale ?? ""}`,
				`**Sources:** ${artifact.sources.length}`,
				`**Passages:** ${artifact.passages.length}`,
				`**responseId:** ${artifact.id}`,
				"",
				"Use get_search_content with this responseId to page the full artifact JSON.",
			].join("\n");

			return {
				content: [{ type: "text", text }],
				details: { responseId: artifact.id, status: assessment?.status, artifact },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("SourceCheck ")) + theme.fg("accent", `"${(args as { claim: string }).claim}"`),
				0,
				0,
			);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) {
				const progress = (result.details as SearchProgressDetails | undefined)?.progress;
				return new Text(
					theme.fg(
						"warning",
						progress
							? `${progress.message} ${formatSearchProgressBar(progress.completed, progress.total)}`
							: "Checking...",
					),
					0,
					0,
				);
			}
			const status = (result.details as { status?: string } | undefined)?.status ?? "done";
			return new Text(theme.fg("success", `✓ ${status}`), 0, 0);
		},
	});
}

function refreshActivityWidget(ctx: ExtensionContext): void {
	if (!activityMonitor.isVisible()) {
		ctx.ui.setWidget("pi-web-tools-activity", undefined);
		return;
	}
	ctx.ui.setWidget("pi-web-tools-activity", activityMonitor.formatLines(), { placement: "bottom" });
}

export function registerActivityAndCommands(pi: ExtensionAPI): void {
	let activityUi: ExtensionContext | null = null;

	pi.on("session_start", async (_event, ctx) => {
		try {
			const { restoreFromSession } = await import("./storage.js");
			restoreFromSession(ctx);
		} catch {
			// ignore
		}
	});

	activityMonitor.onUpdate(() => {
		if (activityUi && activityMonitor.isVisible()) {
			refreshActivityWidget(activityUi);
		}
	});

	pi.registerCommand("activity", {
		description: "Web activity monitor: /activity [on|off|toggle|show|clear]",
		handler: async (args, ctx) => {
			const arg = typeof args === "string" ? args.trim().toLowerCase() : "";

			if (arg === "show" || arg === "print") {
				ctx.ui.notify(activityMonitor.formatLines().join("\n"), "info");
				return;
			}
			if (arg === "clear") {
				activityMonitor.clear();
				if (activityMonitor.isVisible()) refreshActivityWidget(ctx);
				ctx.ui.notify("Web activity cleared", "info");
				return;
			}
			if (arg === "on") {
				activityMonitor.setVisible(true);
			} else if (arg === "off") {
				activityMonitor.setVisible(false);
			} else if (arg === "" || arg === "toggle") {
				activityMonitor.toggleVisible();
			} else {
				ctx.ui.notify("Usage: /activity [on|off|toggle|show|clear]", "error");
				return;
			}

			activityUi = activityMonitor.isVisible() ? ctx : null;
			refreshActivityWidget(ctx);
			ctx.ui.notify(
				activityMonitor.isVisible()
					? "Web activity monitor on (/activity off to hide, /activity show to dump)"
					: "Web activity monitor off",
				"info",
			);
		},
	});

	pi.registerCommand("search", {
		description: "List stored one_search / web_fetch / source_check results for this session",
		handler: async (_args, ctx) => {
			const all = getAllResults();
			if (all.length === 0) {
				ctx.ui.notify("No stored web results in this session", "info");
				return;
			}
			const lines = all.map((r) => {
				const when = new Date(r.timestamp).toISOString();
				const extra =
					r.type === "search"
						? `queries=${r.queries?.length ?? 0}`
						: r.type === "fetch"
							? `urls=${r.urls?.length ?? 0}`
							: "research";
				return `${r.id}  ${r.type}  ${when}  ${extra}`;
			});
			ctx.ui.notify(["Stored web results:", ...lines].join("\n"), "info");
		},
	});

	pi.registerCommand("curator", {
		description: "Toggle search workflow (none | auto-summary)",
		handler: async (args, ctx) => {
			const current = loadConfig();
			const arg = typeof args === "string" ? args.trim().toLowerCase() : "";
			let next = current.workflow ?? "none";
			if (!arg || arg === "toggle") {
				next = next === "none" ? "auto-summary" : "none";
			} else if (arg === "on" || arg === "auto-summary") {
				next = "auto-summary";
			} else if (arg === "off" || arg === "none") {
				next = "none";
			} else {
				ctx.ui.notify("Usage: /curator [on|off|none|auto-summary|toggle]", "error");
				return;
			}
			if (!saveConfig({ ...current, workflow: next })) {
				ctx.ui.notify(`Failed to save workflow to ${CONFIG_PATH}`, "error");
				return;
			}
			ctx.ui.notify(`Search workflow set to ${next}`, "info");
		},
	});

	pi.registerCommand("websearch", {
		description: "Run one or more searches (comma-separated) and show stored responseId",
		handler: async (args, ctx) => {
			const raw = typeof args === "string" ? args.trim() : "";
			if (!raw) {
				ctx.ui.notify("Usage: /websearch query1, query2", "info");
				return;
			}
			const queries = raw.split(",").map((q) => q.trim()).filter(Boolean);
			const config = loadConfig();
			const providers = instantiateSearchProviders(config);
			if (providers.length === 0) {
				ctx.ui.notify(`No search sources configured. Run /${WEB_TOOLS_COMMAND_NAME} first.`, "error");
				return;
			}
			const providerNames = providers.map((p) => p.providerName);
			const limits = buildSourceResultLimits(config, providerNames);
			const mergedLimit = getMergedResultLimit(config);
			const queryDatas = [];
			for (const query of queries) {
				const settled = await Promise.allSettled(
					providers.map(async ({ providerName, provider }) => ({
						providerName,
						response: await provider.search(query, limits[providerName]),
					})),
				);
				const ok = settled
					.filter((r): r is PromiseFulfilledResult<{ providerName: string; response: SearchResponse }> => r.status === "fulfilled")
					.map((r) => r.value);
				const results = ok.length ? mergeSearchResponses(ok, mergedLimit) : [];
				queryDatas.push({
					query,
					results,
					error: ok.length ? null : "all sources failed",
					provider: providerNames.join(","),
					answer: buildDeterministicSummary(query, results),
				});
			}
			const id = generateId();
			persistStored(pi, { id, type: "search", timestamp: Date.now(), queries: queryDatas });
			const lines = queryDatas.map(
				(q) => `• ${q.query}: ${q.results.length} results${q.error ? ` (${q.error})` : ""}`,
			);
			ctx.ui.notify([`Search stored as ${id}`, ...lines, "Use get_search_content or /search"].join("\n"), "info");
		},
	});
}

function renderFetchedContentPreview(content: string, theme: Theme): string {
	const lines = content.split("\n");
	const visible = lines.slice(0, FETCH_PREVIEW_LINE_LIMIT);
	let text = "";
	for (const line of visible) {
		text += `\n  ${theme.fg("dim", line)}`;
	}
	if (lines.length > FETCH_PREVIEW_LINE_LIMIT) {
		text += `\n  ${theme.fg("muted", "... (use read tool to see full content)")}`;
	}
	return text;
}

// ---------------------------------------------------------------------------
// /web-tools command
// ---------------------------------------------------------------------------

function configuredSourceApiKey(current: WebToolsConfig, providerName: string): string | undefined {
	return current.search?.sources?.[providerName]?.apiKey?.trim();
}

function configuredSourceBaseUrl(current: WebToolsConfig, providerName: string): string | undefined {
	return current.search?.sources?.[providerName]?.baseUrl?.trim();
}

function formatShowConfigMessage(current: WebToolsConfig): string {
	const lines = ["Web search config:", `  config file: ${CONFIG_PATH}`];

	lines.push(`  default per-source results: ${getDefaultSourceResultLimit(current)}`);
	lines.push(`  merged result count: ${getMergedResultLimit(current)}`);
	lines.push("  search sources:");

	for (const meta of PROVIDERS) {
		const envKey = meta.envVar ? process.env[meta.envVar]?.trim() : undefined;
		const configKey = configuredSourceApiKey(current, meta.name);
		const resolved = envKey ?? configKey;
		const enabled = current.search?.sources?.[meta.name]?.enabled;
		const configured = isSourceDisabled(current, meta.name)
			? "disabled"
			: isConfiguredSearchProvider(meta, current)
				? "configured"
				: "not configured";
		const enabledLabel = enabled === undefined ? "default" : String(enabled);
		lines.push(
			`    ${meta.name}: ${configured}, enabled=${enabledLabel}, requestLimit=${getSourceResultLimit(current, meta.name)}, key=${maskApiKey(resolved)} (env: ${maskApiKey(envKey)}, config: ${maskApiKey(configKey)})`,
		);
	}

	for (const meta of PROVIDERS) {
		if (!meta.baseUrlEnvVar) continue;
		const envUrl = process.env[meta.baseUrlEnvVar]?.trim();
		const configUrl = configuredSourceBaseUrl(current, meta.name);
		const resolvedUrl = envUrl || configUrl || meta.defaultBaseUrl || "";
		const urlSource = envUrl ? "env" : configUrl ? "config" : "default";
		lines.push(`    ${meta.name} url: ${resolvedUrl} (source: ${urlSource})`);
	}

	const ssrf = ssrfFromConfig(current);
	lines.push("");
	lines.push(`workflow: ${current.workflow ?? "none"}`);
	lines.push(`ssrf.allowRanges: ${ssrf.allowRanges.length ? ssrf.allowRanges.join(", ") : "(none)"}`);
	lines.push(`ssrf.trustEnvProxy: ${ssrf.trustEnvProxy}`);
	const domainPolicy = domainPolicyFromConfig(current);
	if (domainPolicy && (domainPolicy.allow.length || domainPolicy.deny.length)) {
		lines.push(`fetch domainPolicy allow: ${domainPolicy.allow.join(", ") || "(none)"}`);
		lines.push(`fetch domainPolicy deny: ${domainPolicy.deny.join(", ") || "(none)"}`);
	}
	lines.push("");
	lines.push("URL interceptors:");
	const githubInterceptor = getActiveGitHubInterceptor();
	if (githubInterceptor) {
		const opts = githubInterceptor.resolvedOptions;
		const token = process.env[GITHUB_TOKEN_ENV_VAR]?.trim();
		lines.push(
			`  github: enabled (${GITHUB_TOKEN_ENV_VAR}: ${maskApiKey(token)}, maxRepoSizeMB: ${opts.maxRepoSizeMB}, clonePath: ${opts.clonePath}, cloneTtlHours: ${opts.cloneTtlHours})`,
		);
	} else {
		lines.push("  github: disabled");
		lines.push('  ↳ restore default: remove "interceptors.github" or set it to true');
		lines.push('  ↳ disable:        set "interceptors": { "github": false } in config.json');
	}

	return lines.join("\n");
}

export function registerWebSearchConfigCommand(pi: ExtensionAPI): void {
	pi.registerCommand(WEB_TOOLS_COMMAND_NAME, {
		description: "Configure one_search sources, enable/disable flags, API keys, base URLs, per-source result counts, and merged result count",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui?.notify?.(`/${WEB_TOOLS_COMMAND_NAME} requires interactive mode`, "error");
				return;
			}

			const current = loadConfig();

			if (typeof args === "string") {
				try {
					const defaultResults = parsePositiveIntegerArg(args, DEFAULT_RESULTS_COMMAND, "Default per-source result count");
					if (defaultResults !== undefined) {
						const toSave: WebToolsConfig = {
							...current,
							search: { ...current.search, defaultResults },
						};
						if (!saveConfig(toSave)) {
							ctx.ui.notify(`Failed to save default per-source results to ${CONFIG_PATH} — disk write failed`, "error");
							return;
						}
						ctx.ui.notify(`Default per-source one_search result count set to ${defaultResults}`, "info");
						return;
					}

					const mergedResults = parsePositiveIntegerArg(args, MERGED_RESULTS_COMMAND, "Merged result count");
					if (mergedResults !== undefined) {
						const toSave: WebToolsConfig = {
							...current,
							search: { ...current.search, mergedResults },
						};
						if (!saveConfig(toSave)) {
							ctx.ui.notify(`Failed to save merged result count to ${CONFIG_PATH} — disk write failed`, "error");
							return;
						}
						ctx.ui.notify(`Merged one_search result count set to ${mergedResults}`, "info");
						return;
					}

					const sourceResults = parseSourceResultsArg(args);
					if (sourceResults !== undefined) {
						const currentSource = current.search?.sources?.[sourceResults.providerName] ?? {};
						const toSave: WebToolsConfig = {
							...current,
							search: {
								...current.search,
								sources: {
									...current.search?.sources,
									[sourceResults.providerName]: { ...currentSource, resultLimit: sourceResults.resultLimit },
								},
							},
						};
						if (!saveConfig(toSave)) {
							ctx.ui.notify(`Failed to save ${sourceResults.providerName} result count to ${CONFIG_PATH} — disk write failed`, "error");
							return;
						}
						ctx.ui.notify(`${sourceResults.providerName} per-source result count set to ${sourceResults.resultLimit}`, "info");
						return;
					}

					const sourceToEnable = parseProviderNameArg(args, SOURCE_ENABLE_COMMAND);
					if (sourceToEnable !== undefined) {
						const currentSource = current.search?.sources?.[sourceToEnable] ?? {};
						const toSave: WebToolsConfig = {
							...current,
							search: {
								...current.search,
								sources: {
									...current.search?.sources,
									[sourceToEnable]: { ...currentSource, enabled: true },
								},
							},
						};
						if (!saveConfig(toSave)) {
							ctx.ui.notify(`Failed to enable ${sourceToEnable} in ${CONFIG_PATH} — disk write failed`, "error");
							return;
						}
						ctx.ui.notify(`${sourceToEnable} search source enabled`, "info");
						return;
					}

					const sourceToDisable = parseProviderNameArg(args, SOURCE_DISABLE_COMMAND);
					if (sourceToDisable !== undefined) {
						const currentSource = current.search?.sources?.[sourceToDisable] ?? {};
						const toSave: WebToolsConfig = {
							...current,
							search: {
								...current.search,
								sources: {
									...current.search?.sources,
									[sourceToDisable]: { ...currentSource, enabled: false },
								},
							},
						};
						if (!saveConfig(toSave)) {
							ctx.ui.notify(`Failed to disable ${sourceToDisable} in ${CONFIG_PATH} — disk write failed`, "error");
							return;
						}
						ctx.ui.notify(`${sourceToDisable} search source disabled`, "info");
						return;
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
			}

			if (typeof args === "string" && getCommandName(args) === SHOW_COMMAND) {
				ctx.ui.notify(formatShowConfigMessage(current), "info");
				return;
			}

			const labelOf = (p: (typeof PROVIDERS)[number]) => {
				if (isSourceDisabled(current, p.name)) return `${p.label} (disabled)`;
				return isConfiguredSearchProvider(p, current) ? `${p.label} (configured)` : p.label;
			};

			const selectedLabel = await ctx.ui.select("Configure search source", PROVIDERS.map(labelOf), {});
			if (selectedLabel === undefined || selectedLabel === null) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const selectedMeta = PROVIDERS.find(
				(p) => selectedLabel === p.label || selectedLabel.startsWith(`${p.label} `),
			);
			if (!selectedMeta) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}
			const selectedProvider = selectedMeta.name;
			const currentSource = current.search?.sources?.[selectedProvider] ?? {};

			if (selectedMeta.configure) {
				const result = await selectedMeta.configure(ctx.ui, {
					baseUrl: currentSource.baseUrl,
					apiKey: currentSource.apiKey,
				});
				if (!result) {
					ctx.ui.notify("Web search config unchanged", "info");
					return;
				}
				const nextSource = { ...currentSource, enabled: true };
				if (result.baseUrl !== undefined) nextSource.baseUrl = result.baseUrl;
				if (result.apiKey) nextSource.apiKey = result.apiKey;
				if (result.apiKey === null) delete nextSource.apiKey;
				const toSave: WebToolsConfig = {
					...current,
					search: {
						...current.search,
						sources: { ...current.search?.sources, [selectedProvider]: nextSource },
					},
				};
				if (!saveConfig(toSave)) {
					ctx.ui.notify(
						`Failed to save ${selectedMeta.label} source config to ${CONFIG_PATH} — disk write failed`,
						"error",
					);
					return;
				}
				ctx.ui.notify(`Saved ${selectedMeta.label} search source config to ${CONFIG_PATH}`, "info");
				return;
			}

			const existingKey = currentSource.apiKey;
			const input = await ctx.ui.input(
				`${selectedMeta.label} API key`,
				existingKey ? `Press Enter to keep current (${maskApiKey(existingKey)}), or type new key` : "...",
			);

			if (input === undefined || input === null) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const trimmed = input.trim();
			const keyToWrite = trimmed || existingKey;
			if (!keyToWrite) {
				ctx.ui.notify("Web search config unchanged", "info");
				return;
			}

			const toSave: WebToolsConfig = {
				...current,
				search: {
					...current.search,
					sources: {
						...current.search?.sources,
						[selectedProvider]: { ...currentSource, apiKey: keyToWrite, enabled: true },
					},
				},
			};
			if (!saveConfig(toSave)) {
				ctx.ui.notify(
					`Failed to save ${selectedMeta.label} API key to ${CONFIG_PATH} — disk write failed`,
					"error",
				);
				return;
			}
			ctx.ui.notify(`Saved ${selectedMeta.label} search source API key to ${CONFIG_PATH}`, "info");
		},
	});
}
