import {
	isCancellation,
	type ProviderConfigChange,
	type ProviderConfigCurrent,
	type ProviderConfigUi,
	type ProviderMeta,
	type SearchProvider,
	type SearchResponse,
	type SearchResult,
} from "./types.js";

export const ONESEARCH_API_KEY_ENV_VAR = "ONESEARCH_API_KEY";
export const ONESEARCH_URL_ENV_VAR = "ONESEARCH_URL";
export const ONESEARCH_DEFAULT_URL = "http://localhost:5173";

const ONESEARCH_SEARCH_PATH = "/v1/search";
const MASK_VISIBLE_CHARS = 4;

export type OnesearchConfigUi = ProviderConfigUi;
export type OnesearchConfigCurrent = ProviderConfigCurrent;
export type OnesearchConfigChange = ProviderConfigChange;

export const ONESEARCH_PROVIDER_META: ProviderMeta = {
	name: "onesearch",
	label: "OneSearch",
	envVar: ONESEARCH_API_KEY_ENV_VAR,
	baseUrlEnvVar: ONESEARCH_URL_ENV_VAR,
	defaultBaseUrl: ONESEARCH_DEFAULT_URL,
	roles: ["search"],
	configure: (ui, current) => configureOnesearch(ui, current),
};

interface OnesearchRawResult {
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
}

interface OnesearchRawError {
	message?: string;
	status?: number;
}

interface OnesearchRawResponse {
	results?: OnesearchRawResult[];
	error?: OnesearchRawError;
}

function normalizeOnesearchResults(raw: OnesearchRawResponse, maxResults: number): SearchResult[] {
	return (raw.results ?? []).slice(0, maxResults).map((r) => ({
		title: r.title ?? "",
		url: r.url ?? "",
		snippet: r.snippet ?? r.content ?? "",
	}));
}

function stripTrailingSlashes(url: string): string {
	return url.replace(/\/+$/, "");
}

function assertHttpUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${ONESEARCH_URL_ENV_VAR} is not a valid URL (got: ${url})`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`${ONESEARCH_URL_ENV_VAR} must use http:// or https:// (got: ${parsed.protocol.replace(":", "")}://)`,
		);
	}
}

function hintForSearchStatus(status: number): string {
	if (status === 401 || status === 403) {
		return ` (check ${ONESEARCH_API_KEY_ENV_VAR} or search.sources.onesearch.apiKey; OneSearch expects an osr_ API token or oak_ admin API key when API_AUTH_REQUIRED=true)`;
	}
	if (status === 404) {
		return ` (check ${ONESEARCH_URL_ENV_VAR}; configure the OneSearch Relay root URL, not the /v1/search path)`;
	}
	return "";
}

function parseErrorMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as OnesearchRawResponse;
		return parsed.error?.message || body;
	} catch {
		return body;
	}
}

interface OnesearchProviderOptions {
	apiKey?: string;
	baseUrl: string;
}

export class OnesearchProvider implements SearchProvider {
	readonly name = "onesearch";
	readonly label = "OneSearch";
	readonly envVar = ONESEARCH_API_KEY_ENV_VAR;

	private readonly apiKey?: string;
	private readonly baseUrl: string;

	constructor(options: OnesearchProviderOptions) {
		this.apiKey = options.apiKey?.trim() || undefined;
		const trimmed = stripTrailingSlashes(options.baseUrl?.trim() ?? "");
		if (trimmed) assertHttpUrl(trimmed);
		this.baseUrl = trimmed;
	}

	async search(query: string, maxResults: number, signal?: AbortSignal): Promise<SearchResponse> {
		this.requireBaseUrl();
		const res = await fetch(`${this.baseUrl}${ONESEARCH_SEARCH_PATH}`, {
			method: "POST",
			headers: this.buildHeaders(),
			body: JSON.stringify({ query, limit: maxResults, include_raw: false }),
			signal,
		});
		if (!res.ok) throw await this.searchApiError(res);
		const raw = (await res.json()) as OnesearchRawResponse;
		return { query, results: normalizeOnesearchResults(raw, maxResults) };
	}

	private requireBaseUrl(): void {
		if (!this.baseUrl) {
			throw new Error(`${ONESEARCH_URL_ENV_VAR} is not set. Run /web-tools to configure, or export the env var.`);
		}
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
		return headers;
	}

	private async searchApiError(res: Response): Promise<Error> {
		const body = await res.text();
		return new Error(`${this.label} Search API error (${res.status})${hintForSearchStatus(res.status)}: ${parseErrorMessage(body)}`);
	}
}

function maskKey(key: string): string {
	const head = key.slice(0, MASK_VISIBLE_CHARS);
	const tail = key.slice(-MASK_VISIBLE_CHARS);
	return `${head}...${tail}`;
}

async function promptForBaseUrl(ui: ProviderConfigUi, current: string | undefined): Promise<string | undefined> {
	const existing = current?.trim();
	const input = await ui.input(
		"OneSearch base URL",
		existing
			? `Press Enter to keep current (${existing}), or type new URL`
			: `Press Enter for default (${ONESEARCH_DEFAULT_URL}), or type OneSearch Relay URL`,
	);
	if (isCancellation(input)) return undefined;
	return input.trim() || existing || ONESEARCH_DEFAULT_URL;
}

async function promptForOptionalKey(
	ui: ProviderConfigUi,
	current: string | undefined,
): Promise<string | null | undefined> {
	const existing = current?.trim() || undefined;
	const input = await ui.input(
		"OneSearch API token (optional — osr_ external token or oak_ admin key)",
		existing
			? `Press Enter to keep current (${maskKey(existing)}), or type new token`
			: "Press Enter to leave unset when API_AUTH_REQUIRED=false, or type a token",
	);
	if (isCancellation(input)) return undefined;
	return input.trim() || existing || null;
}

export async function configureOnesearch(
	ui: OnesearchConfigUi,
	current: OnesearchConfigCurrent,
): Promise<OnesearchConfigChange | null> {
	const baseUrl = await promptForBaseUrl(ui, current.baseUrl);
	if (baseUrl === undefined) return null;

	const apiKey = await promptForOptionalKey(ui, current.apiKey);
	if (apiKey === undefined) return null;

	return { baseUrl, apiKey };
}
