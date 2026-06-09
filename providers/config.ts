/**
 * Single typed reader/writer for the rpiv-web-tools Pi extension config.
 *
 * Canonical config uses a multi-source search shape:
 *
 * {
 *   "search": {
 *     "defaultResults": 10,
 *     "mergedResults": 20,
 *     "sources": {
 *       "exa": { "apiKey": "...", "resultLimit": 10 },
 *       "searxng": { "baseUrl": "http://localhost:8080" }
 *     }
 *   }
 * }
 *
 * Legacy fields (`provider`, `apiKeys`, `baseUrls`, `defaultSearchResults`,
 * `apiKey`) are accepted as migration input but are never written back.
 * Unknown keys pass through so existing guidance/interceptor settings keep
 * working. Validation is fail-soft: malformed JSON, EISDIR, or a hard schema
 * violation degrade to `{}`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export interface SearchSourceConfig {
	apiKey?: string;
	baseUrl?: string;
	resultLimit?: number;
	[key: string]: unknown;
}

export interface SearchConfig {
	defaultResults?: number;
	mergedResults?: number;
	sources?: Record<string, SearchSourceConfig>;
	[key: string]: unknown;
}

export interface GitHubInterceptorOptionsConfig {
	enabled?: boolean;
	maxRepoSizeMB?: number;
	cloneTimeoutSeconds?: number;
	clonePath?: string;
	[key: string]: unknown;
}

export interface WebToolsConfig {
	search?: SearchConfig;
	guidance?: {
		web_search?: GuidanceFields;
		web_fetch?: GuidanceFields;
		[key: string]: unknown;
	};
	interceptors?: {
		github?: boolean | GitHubInterceptorOptionsConfig;
		[key: string]: unknown;
	};

	// Legacy input fields. Kept optional for migration/backward compatibility;
	// writeConfig() canonicalizes them into search.sources/search.defaultResults.
	provider?: string;
	apiKeys?: Record<string, string>;
	baseUrls?: Record<string, string>;
	defaultSearchResults?: number;
	apiKey?: string;

	[key: string]: unknown;
}

export const WebToolsConfigSchema = { type: "object" } as const;

const CONFIG_FILE_MODE = 0o600;
const EXTENSION_NAME = "rpiv-web-tools";
const CONFIG_FILE_NAME = "config.json";
const LEGACY_CONFIG_PATH = join(homedir(), ".config", EXTENSION_NAME, CONFIG_FILE_NAME);
const CONFIG_PATH = configPath(EXTENSION_NAME);

export function configPath(name: string, file: string = CONFIG_FILE_NAME): string {
	return join(getAgentDir(), "extensions", name, file);
}

export function getConfigPath(): string {
	return CONFIG_PATH;
}

export function getLegacyConfigPath(): string {
	return LEGACY_CONFIG_PATH;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isSearchSourceConfig(value: unknown): value is SearchSourceConfig {
	if (!isPlainObject(value)) return false;
	if ("apiKey" in value && value.apiKey !== undefined && typeof value.apiKey !== "string") return false;
	if ("baseUrl" in value && value.baseUrl !== undefined && typeof value.baseUrl !== "string") return false;
	if ("resultLimit" in value && value.resultLimit !== undefined && typeof value.resultLimit !== "number") return false;
	return true;
}

function isSearchSources(value: unknown): value is Record<string, SearchSourceConfig> {
	return isPlainObject(value) && Object.values(value).every(isSearchSourceConfig);
}

function isSearchConfig(value: unknown): value is SearchConfig {
	if (!isPlainObject(value)) return false;
	if ("defaultResults" in value && value.defaultResults !== undefined && typeof value.defaultResults !== "number") {
		return false;
	}
	if ("mergedResults" in value && value.mergedResults !== undefined && typeof value.mergedResults !== "number") {
		return false;
	}
	if ("sources" in value && value.sources !== undefined && !isSearchSources(value.sources)) return false;
	return true;
}

function isGuidanceFields(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	if ("promptSnippet" in value && value.promptSnippet !== undefined && typeof value.promptSnippet !== "string") return false;
	if (
		"promptGuidelines" in value &&
		value.promptGuidelines !== undefined &&
		(!Array.isArray(value.promptGuidelines) || !value.promptGuidelines.every((entry) => typeof entry === "string"))
	) {
		return false;
	}
	return true;
}

function isGuidanceConfig(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	if ("web_search" in value && value.web_search !== undefined && !isGuidanceFields(value.web_search)) return false;
	if ("web_fetch" in value && value.web_fetch !== undefined && !isGuidanceFields(value.web_fetch)) return false;
	return true;
}

function isGitHubInterceptorOptions(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	if ("enabled" in value && value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
	if ("maxRepoSizeMB" in value && value.maxRepoSizeMB !== undefined && typeof value.maxRepoSizeMB !== "number") return false;
	if (
		"cloneTimeoutSeconds" in value &&
		value.cloneTimeoutSeconds !== undefined &&
		typeof value.cloneTimeoutSeconds !== "number"
	) {
		return false;
	}
	if ("clonePath" in value && value.clonePath !== undefined && typeof value.clonePath !== "string") return false;
	return true;
}

function isInterceptorsConfig(value: unknown): boolean {
	if (!isPlainObject(value)) return false;
	if (
		"github" in value &&
		value.github !== undefined &&
		typeof value.github !== "boolean" &&
		!isGitHubInterceptorOptions(value.github)
	) {
		return false;
	}
	return true;
}

function isWebToolsConfig(value: unknown): value is WebToolsConfig {
	if (!isPlainObject(value)) return false;
	if ("search" in value && value.search !== undefined && !isSearchConfig(value.search)) return false;
	if ("provider" in value && value.provider !== undefined && typeof value.provider !== "string") return false;
	if ("apiKeys" in value && value.apiKeys !== undefined && !isStringRecord(value.apiKeys)) return false;
	if ("baseUrls" in value && value.baseUrls !== undefined && !isStringRecord(value.baseUrls)) return false;
	if (
		"defaultSearchResults" in value &&
		value.defaultSearchResults !== undefined &&
		typeof value.defaultSearchResults !== "number"
	) {
		return false;
	}
	if ("apiKey" in value && value.apiKey !== undefined && typeof value.apiKey !== "string") return false;
	if ("guidance" in value && value.guidance !== undefined && !isGuidanceConfig(value.guidance)) return false;
	if ("interceptors" in value && value.interceptors !== undefined && !isInterceptorsConfig(value.interceptors)) return false;
	return true;
}

function hasLegacyConfigShape(config: WebToolsConfig): boolean {
	return (
		"provider" in config ||
		"apiKeys" in config ||
		"baseUrls" in config ||
		"defaultSearchResults" in config ||
		"apiKey" in config
	);
}

function setSourceField(
	sources: Record<string, SearchSourceConfig>,
	providerName: string,
	field: "apiKey" | "baseUrl",
	value: string | undefined,
): void {
	if (typeof value !== "string") return;
	const source = sources[providerName] ?? {};
	source[field] = value;
	sources[providerName] = source;
}

function copySearchSources(rawSources: Record<string, SearchSourceConfig> | undefined): Record<string, SearchSourceConfig> {
	const sources: Record<string, SearchSourceConfig> = {};
	for (const [providerName, source] of Object.entries(rawSources ?? {})) {
		sources[providerName] = { ...source };
	}
	return sources;
}

function toCanonicalConfig(config: WebToolsConfig): WebToolsConfig {
	const {
		provider: _provider,
		apiKeys,
		baseUrls,
		defaultSearchResults,
		apiKey,
		search: rawSearch,
		...rest
	} = config;
	const search: SearchConfig = rawSearch ? { ...rawSearch } : {};
	const sources = copySearchSources(rawSearch?.sources);

	for (const [providerName, value] of Object.entries(apiKeys ?? {})) {
		if (sources[providerName]?.apiKey === undefined) setSourceField(sources, providerName, "apiKey", value);
	}
	if (apiKey !== undefined && sources.brave?.apiKey === undefined) {
		setSourceField(sources, "brave", "apiKey", apiKey);
	}
	for (const [providerName, value] of Object.entries(baseUrls ?? {})) {
		if (sources[providerName]?.baseUrl === undefined) setSourceField(sources, providerName, "baseUrl", value);
	}
	if (defaultSearchResults !== undefined && search.defaultResults === undefined) {
		search.defaultResults = defaultSearchResults;
	}

	if (Object.keys(sources).length > 0) {
		search.sources = sources;
	} else {
		delete search.sources;
	}

	const canonical: WebToolsConfig = { ...rest };
	if (Object.keys(search).length > 0) {
		canonical.search = search;
	}
	return canonical;
}

function loadJsonConfig(path: string): unknown {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isPlainObject(parsed)) return {};
		return parsed;
	} catch (err) {
		console.warn(`rpiv-web-tools: invalid JSON at ${path}, using default ({}) — ${(err as Error).message}`);
		return {};
	}
}

function saveJsonConfig(path: string, data: unknown): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
	} catch {
		return false;
	}
	try {
		chmodSync(path, CONFIG_FILE_MODE);
	} catch {
		// chmod is best-effort only.
	}
	return true;
}

export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const guidance = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof guidance.promptSnippet === "string" && guidance.promptSnippet.length > 0) {
		result.promptSnippet = guidance.promptSnippet;
	}
	if (
		Array.isArray(guidance.promptGuidelines) &&
		guidance.promptGuidelines.length > 0 &&
		guidance.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = guidance.promptGuidelines;
	}
	return result;
}

export function readConfig(): WebToolsConfig {
	const shouldReadLegacyPath = !existsSync(CONFIG_PATH) && existsSync(LEGACY_CONFIG_PATH);
	const raw = loadJsonConfig(shouldReadLegacyPath ? LEGACY_CONFIG_PATH : CONFIG_PATH);
	if (!isWebToolsConfig(raw)) return {};
	const canonical = toCanonicalConfig(raw);
	if (shouldReadLegacyPath || hasLegacyConfigShape(raw)) {
		saveJsonConfig(CONFIG_PATH, canonical);
	}
	return canonical;
}

export function writeConfig(c: WebToolsConfig): boolean {
	return saveJsonConfig(CONFIG_PATH, toCanonicalConfig(c));
}

// Plan-surface no-op. Phase 4 omits the in-memory cache the plan sketched —
// the tests' direct-writeFileSync pattern makes per-test invalidation a
// rewrite-the-suite job for marginal perf gain. Kept exported so that
// consumers writing against the plan's API can call it without breaking.
export function invalidateConfigCache(): void {
	// no-op
}
