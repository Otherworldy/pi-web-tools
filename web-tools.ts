/**
 * rpiv-web-tools — body
 *
 * Provides `web_search` and `web_fetch` tools backed by configurable search
 * providers (Brave, Tavily, Serper, Exa), plus the `/web-tools`
 * slash command for search source configuration. web_search queries all
 * configured sources concurrently; web_fetch uses URL interceptors plus generic HTML fetch.
 *
 * API key resolution precedence per search source (first wins):
 *   1. Source environment variable (e.g. BRAVE_SEARCH_API_KEY, TAVILY_API_KEY)
 *   2. search.sources[source].apiKey field in the Pi agent extension config file
 *   3. (Brave only, legacy migration) apiKey field in config.json
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { getConfigPath, readConfig, validateGuidanceFields, type WebToolsConfig, writeConfig } from "./providers/config.js";
import { createSearchProvider } from "./providers/factory.js";
import { fetchViaGenericHtml } from "./providers/fetch-helpers.js";
import { PROVIDERS } from "./providers/index.js";
import { GITHUB_TOKEN_ENV_VAR, getActiveGitHubInterceptor, getInterceptors } from "./providers/interceptors/index.js";
import type {
	FetchResponse,
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

const FETCH_TEMP_DIR_PREFIX = "rpiv-fetch-";
const FETCH_TEMP_FILE_NAME = "content.txt";

const CONFIG_PATH = getConfigPath();

const SUPPORTED_HTTP_PROTOCOLS = new Set(["http:", "https:"]);

const WEB_TOOLS_COMMAND_NAME = "web-tools";
const SHOW_COMMAND = "show";
const DEFAULT_RESULTS_COMMAND = "default-results";
const MERGED_RESULTS_COMMAND = "merged-results";
const SOURCE_RESULTS_COMMAND = "source-results";
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
	"Use web_search for information beyond your training data — recent events, current library versions, live API documentation.",
	"web_search queries all configured search sources concurrently, then merges and de-duplicates results by URL.",
	"search.defaultResults controls the per-source request count; search.mergedResults controls the default final merged result count.",
	"Only pass max_results when the user explicitly asks for a specific final result count; otherwise omit it so the configured search.mergedResults is used.",
	'Use the current year from "Current date:" in your context when searching for recent information or documentation.',
	'After answering using search results, include a "Sources:" section listing relevant URLs as markdown hyperlinks: [Title](URL). Never skip this.',
	"Domain filtering is supported to include or block specific websites.",
	"If no search source is configured, ask the user to run /web-tools before proceeding.",
];

export const DEFAULT_WEB_FETCH_SNIPPET = "Fetch and read content from a specific URL";
export const DEFAULT_WEB_FETCH_GUIDELINES: string[] = [
	"Use web_fetch to read the full content of a specific URL — documentation pages, blog posts, API references found via web_search.",
	"web_fetch is complementary to web_search: search finds URLs, fetch reads them.",
	'After answering using fetched content, include a "Sources:" section with a markdown hyperlink to the fetched URL.',
	"Large responses are truncated and spilled to a temp file — the temp path is reported in the result details.",
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
	return normalizeResultCount(config.search?.sources?.[providerName]?.resultLimit, getDefaultSourceResultLimit(config));
}

function resolveMergedResultLimit(requested: number | undefined, config: WebToolsConfig): number {
	return requested === undefined ? getMergedResultLimit(config) : normalizeResultCount(requested, getMergedResultLimit(config));
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

function isConfiguredSearchProvider(meta: ProviderMeta, config: WebToolsConfig): boolean {
	if (!meta.roles.includes("search")) return false;
	const apiKey = resolveProviderApiKey(meta.name, config);
	if (!meta.baseUrlEnvVar) return apiKey !== undefined;
	return Boolean(
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
// URL guard
// ---------------------------------------------------------------------------

function isPrivateOrLoopbackHostname(hostname: string): boolean {
	const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	// IPv6 loopback / unspecified / link-local / unique-local
	if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
	// IPv4 literals
	const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!v4) return false;
	const [a, b] = [Number(v4[1]), Number(v4[2])];
	if (a === 0 || a === 127 || a === 10) return true; // 0.0.0.0/8, loopback, RFC1918
	if (a === 169 && b === 254) return true; // link-local (incl. AWS metadata 169.254.169.254)
	if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16.0.0/12
	if (a === 192 && b === 168) return true; // RFC1918 192.168.0.0/16
	return false;
}

function parseAndAssertHttpUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Invalid URL: ${raw}`);
	}
	if (!SUPPORTED_HTTP_PROTOCOLS.has(parsed.protocol)) {
		throw new Error(`Unsupported URL protocol: ${parsed.protocol}. Only http and https are supported.`);
	}
	if (isPrivateOrLoopbackHostname(parsed.hostname)) {
		throw new Error(`Refusing to fetch private/loopback address: ${parsed.hostname}`);
	}
	return parsed;
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
// web_search result rendering
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
		name: "web_search",
		label: "Web Search",
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
				max_results: {
					type: "number",
					description: `Optional final merged result count. Omit unless the user explicitly asks for a specific count; omitted calls use configured search.mergedResults (${defaultMergedResults}). Per-source request counts are configured separately.`,
					minimum: MIN_SEARCH_RESULTS,
				},
			},
			required: ["query"],
		},

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const config = loadConfig();
			const mergedResultLimit = resolveMergedResultLimit(params.max_results, config);
			const providers = instantiateSearchProviders(config);
			if (providers.length === 0) {
				throw new Error(`No search sources configured. Run /${WEB_TOOLS_COMMAND_NAME} to configure one or more sources.`);
			}
			const providerNames = providers.map(({ providerName }) => providerName);
			const sourceResultLimits = buildSourceResultLimits(config, providerNames);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Searching ${searchableProviderLabels(providers)} for: "${params.query}"...`,
					},
				],
				details: {
					query: params.query,
					backend: providerNames.join(","),
					backends: providerNames,
					sourceResultLimits,
					mergedResultLimit,
					resultCount: 0,
				},
			});

			const settled = await Promise.allSettled(
				providers.map(async ({ providerName, provider }) => ({
					providerName,
					response: await provider.search(params.query, sourceResultLimits[providerName], signal),
				})),
			);
			throwIfAborted(signal);
			const successfulResponses: Array<{ providerName: string; response: SearchResponse }> = [];
			const failedResponses: Array<{ providerName: string; reason: unknown }> = [];
			settled.forEach((result, index) => {
				if (result.status === "fulfilled") {
					successfulResponses.push(result.value);
				} else {
					failedResponses.push({ providerName: providers[index].providerName, reason: result.reason });
				}
			});

			const failures = formatSourceFailures(failedResponses);
			if (successfulResponses.length === 0) {
				throw new Error(`All configured search sources failed: ${failures.join("; ")}`);
			}

			const sourceResultCounts = countResultsBySource(successfulResponses);
			const results = mergeSearchResponses(successfulResponses, mergedResultLimit);

			if (results.length === 0) {
				return buildEmptyResultsEnvelope(params.query, providerNames, failures, sourceResultCounts, sourceResultLimits, mergedResultLimit);
			}

			return {
				content: [
					{
						type: "text",
						text: formatSearchResultsBody({
							query: params.query,
							results,
							failures,
							sourceResultCounts,
							sourceResultLimits,
							mergedResultLimit,
						}),
					},
				],
				details: {
					query: params.query,
					backend: providerNames.join(","),
					backends: providerNames,
					sourceResultLimits,
					sourceResultCounts,
					mergedResultLimit,
					resultCount: results.length,
					results,
					failures,
				},
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("WebSearch "));
			text += theme.fg("accent", `"${args.query}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
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

export function registerWebFetchTool(pi: ExtensionAPI): void {
	const guidance = validateGuidanceFields(loadConfig().guidance?.web_fetch);

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch the content of a specific URL. Returns text content for HTML pages (tags stripped), raw text for plain text or JSON. Supports http and https only. Content is truncated to avoid overwhelming the context window.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_WEB_FETCH_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_WEB_FETCH_GUIDELINES,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "The URL to fetch. Must be http or https.",
				},
				raw: {
					type: "boolean",
					description: "If true, return the raw HTML instead of extracted text. Default: false.",
					default: false,
				},
			},
			required: ["url"],
		},

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { url, raw = false } = params;
			parseAndAssertHttpUrl(url);

			onUpdate?.({
				content: [{ type: "text", text: `Fetching: ${url}...` }],
				details: { url } as FetchDetails,
			});

			const config = loadConfig();
			const fetchProviders = instantiateFetchProviders(config);

			// Three-way capability dispatch:
			//   1. URL interceptors (currently just GitHub) — opt-in URL specialists
			//      that handle their own host pattern. Cheap-reject to null for
			//      unrelated URLs; empty chain (interceptor disabled) is a no-op.
			//   2. Configured fetch-capable sources (Tavily, Exa, Jina, Firecrawl,
			//      Ollama) — tried in provider registry order.
			//   3. Generic HTML fallback — no search source selection required.
			let fetchResponse: FetchResponse | undefined;
			for (const interceptor of getInterceptors()) {
				const r = await interceptor.intercept(url, { raw, signal });
				if (r) {
					fetchResponse = r;
					break;
				}
			}
			for (const provider of fetchProviders) {
				if (fetchResponse) break;
				fetchResponse = await provider.fetch(url, raw, signal);
			}
			if (!fetchResponse) {
				fetchResponse = await fetchViaGenericHtml(url, raw, signal);
			}
			const { text: bodyText, title, contentType, contentLength } = fetchResponse;

			const truncation = truncateHead(bodyText, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: FetchDetails = {
				url,
				title,
				contentType,
				contentLength,
			};

			let output = truncation.content;
			if (truncation.truncated) {
				const tempFile = await spillFullContentToTempFile(bodyText);
				details.truncation = truncation;
				details.fullOutputPath = tempFile;
				output += formatTruncationFooter(truncation, tempFile);
			}

			return {
				content: [{ type: "text", text: formatFetchHeader(url, title, contentType ?? "") + output }],
				details,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("WebFetch "));
			text += theme.fg("accent", args.url);
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
		const configured = isConfiguredSearchProvider(meta, current) ? "configured" : "not configured";
		lines.push(
			`    ${meta.name}: ${configured}, requestLimit=${getSourceResultLimit(current, meta.name)}, key=${maskApiKey(resolved)} (env: ${maskApiKey(envKey)}, config: ${maskApiKey(configKey)})`,
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

	lines.push("");
	lines.push("URL interceptors:");
	const githubInterceptor = getActiveGitHubInterceptor();
	if (githubInterceptor) {
		const opts = githubInterceptor.resolvedOptions;
		const token = process.env[GITHUB_TOKEN_ENV_VAR]?.trim();
		lines.push(
			`  github: enabled (${GITHUB_TOKEN_ENV_VAR}: ${maskApiKey(token)}, maxRepoSizeMB: ${opts.maxRepoSizeMB}, clonePath: ${opts.clonePath})`,
		);
	} else {
		lines.push("  github: disabled");
		lines.push('  ↳ enable:  add  "interceptors": { "github": true }   to config.json');
		lines.push('  ↳ disable: set  "interceptors": { "github": false }  to override a consumer-enabled default');
	}

	return lines.join("\n");
}

export function registerWebSearchConfigCommand(pi: ExtensionAPI): void {
	pi.registerCommand(WEB_TOOLS_COMMAND_NAME, {
		description: "Configure web_search sources, API keys, base URLs, per-source result counts, and merged result count",
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
						ctx.ui.notify(`Default per-source web_search result count set to ${defaultResults}`, "info");
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
						ctx.ui.notify(`Merged web_search result count set to ${mergedResults}`, "info");
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
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
			}

			if (typeof args === "string" && getCommandName(args) === SHOW_COMMAND) {
				ctx.ui.notify(formatShowConfigMessage(current), "info");
				return;
			}

			const labelOf = (p: (typeof PROVIDERS)[number]) =>
				isConfiguredSearchProvider(p, current) ? `${p.label} (configured)` : p.label;

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
				const nextSource = { ...currentSource };
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
						[selectedProvider]: { ...currentSource, apiKey: keyToWrite },
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
