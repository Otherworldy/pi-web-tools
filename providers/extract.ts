/**
 * Fetch extraction pipeline: SSRF-safe HTTP → PDF / RSC / HTML → fallbacks (Jina, Firecrawl, other fetch providers).
 */

import { activityMonitor } from "../activity.js";
import { extractPDFToMarkdown, isPDF } from "../pdf-extract.js";
import { extractRSCContent } from "../rsc-extract.js";
import type { ExtractedContent } from "../storage.js";
import type { WebToolsConfig } from "./config.js";
import {
	assertTextContentType,
	extractTitle,
	htmlToText,
	isHtmlContentType,
} from "./fetch-helpers.js";
import type { DomainPolicy, Lookup } from "./ssrf.js";
import { fetchRemoteUrl, validateRemoteUrl } from "./ssrf.js";
import type { FullProvider } from "./types.js";

const USER_AGENT = "Mozilla/5.0 (compatible; pi-web-tools/2.0)";
const FETCH_ACCEPT =
	"text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,text/plain;q=0.8,*/*;q=0.5";
const MIN_USEFUL_CONTENT = 200;
const COOKIE_WALL_HINTS = [
	"enable javascript",
	"please enable cookies",
	"just a moment",
	"checking your browser",
	"cf-browser-verification",
	"attention required",
	"verify you are human",
];
const JINA_READER_BASE = "https://r.jina.ai/";

export interface ExtractOptions {
	raw?: boolean;
	signal?: AbortSignal;
	lookup?: Lookup;
	ssrf?: { allowRanges?: string[]; trustEnvProxy?: boolean };
	domainPolicy?: DomainPolicy;
	fetchProviders?: FullProvider[];
	jinaApiKey?: string;
}

function isThinOrBlocked(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length < MIN_USEFUL_CONTENT) return true;
	const lower = trimmed.toLowerCase();
	return COOKIE_WALL_HINTS.some((hint) => lower.includes(hint));
}

function resolveSsrfOptions(options: ExtractOptions) {
	return {
		allowRanges: options.ssrf?.allowRanges ?? [],
		trustEnvProxy: options.ssrf?.trustEnvProxy === true,
		domainPolicy: options.domainPolicy,
		lookup: options.lookup,
	};
}

async function extractWithJina(url: string, options: ExtractOptions): Promise<ExtractedContent | null> {
	const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });
	try {
		const ssrf = resolveSsrfOptions(options);
		await validateRemoteUrl(url, ssrf);
		const headers: Record<string, string> = { Accept: "text/markdown", "X-No-Cache": "true" };
		if (options.jinaApiKey) headers.Authorization = `Bearer ${options.jinaApiKey}`;
		const res = await fetch(JINA_READER_BASE + url, {
			headers,
			signal: options.signal
				? AbortSignal.any([AbortSignal.timeout(30_000), options.signal])
				: AbortSignal.timeout(30_000),
		});
		if (!res.ok) {
			activityMonitor.logComplete(activityId, res.status);
			return null;
		}
		const body = await res.text();
		activityMonitor.logComplete(activityId, res.status);
		const contentStart = body.indexOf("Markdown Content:");
		const markdown = (contentStart >= 0 ? body.slice(contentStart + 17) : body).trim();
		if (isThinOrBlocked(markdown)) return null;
		const title = extractTitle(body) ?? (new URL(url).pathname.split("/").filter(Boolean).pop() || url);
		return { url, title, content: markdown, error: null };
	} catch (err) {
		activityMonitor.logError(activityId, err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function extractUrl(url: string, options: ExtractOptions = {}): Promise<ExtractedContent> {
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	const ssrf = resolveSsrfOptions(options);
	const raw = options.raw === true;

	try {
		const response = await fetchRemoteUrl(
			url,
			{
				signal: options.signal,
				headers: { "User-Agent": USER_AGENT, Accept: FETCH_ACCEPT },
			},
			ssrf,
		);

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: "", content: "", error: `HTTP ${response.status} ${response.statusText}` };
		}

		const contentType = response.headers.get("content-type") ?? "";
		const buffer = Buffer.from(await response.arrayBuffer());

		if (isPDF(url, contentType)) {
			const pdf = await extractPDFToMarkdown(buffer, url);
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: pdf.title,
				content: `${pdf.content}\n\n[PDF saved to: ${pdf.outputPath}]`,
				error: null,
				outputPath: pdf.outputPath,
			};
		}

		assertTextContentType(contentType);
		const bodyText = buffer.toString("utf8");

		if (raw || !isHtmlContentType(contentType)) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: isHtmlContentType(contentType) ? extractTitle(bodyText) ?? "" : "",
				content: bodyText,
				error: null,
			};
		}

		const rsc = extractRSCContent(bodyText);
		if (rsc && !isThinOrBlocked(rsc.content)) {
			activityMonitor.logComplete(activityId, response.status);
			return { url, title: rsc.title || extractTitle(bodyText) || "", content: rsc.content, error: null };
		}

		const title = extractTitle(bodyText) ?? "";
		const text = htmlToText(bodyText);
		if (!isThinOrBlocked(text)) {
			activityMonitor.logComplete(activityId, response.status);
			return { url, title, content: text, error: null };
		}

		// Fallbacks for thin / cookie-wall pages
		for (const provider of options.fetchProviders ?? []) {
			try {
				const fetched = await provider.fetch(url, false, options.signal);
				if (fetched.text && !isThinOrBlocked(fetched.text)) {
					activityMonitor.logComplete(activityId, response.status);
					return {
						url,
						title: fetched.title ?? title,
						content: fetched.text,
						error: null,
					};
				}
			} catch {
				// try next
			}
		}

		const jina = await extractWithJina(url, options);
		if (jina) {
			activityMonitor.logComplete(activityId, response.status);
			return jina;
		}

		activityMonitor.logComplete(activityId, response.status);
		return {
			url,
			title,
			content: text,
			error: text.length > 0 ? null : "Extraction returned empty content",
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		activityMonitor.logError(activityId, message);
		return { url, title: "", content: "", error: message };
	}
}

export function domainPolicyFromConfig(config: WebToolsConfig): DomainPolicy | undefined {
	const policy = config.fetchContent?.domainPolicy;
	if (!policy) return undefined;
	return {
		allow: Array.isArray(policy.allow) ? policy.allow.filter((v): v is string => typeof v === "string") : [],
		deny: Array.isArray(policy.deny) ? policy.deny.filter((v): v is string => typeof v === "string") : [],
	};
}

export function ssrfFromConfig(config: WebToolsConfig): { allowRanges: string[]; trustEnvProxy: boolean } {
	return {
		allowRanges: Array.isArray(config.ssrf?.allowRanges)
			? config.ssrf.allowRanges.filter((v): v is string => typeof v === "string")
			: [],
		trustEnvProxy: config.ssrf?.trustEnvProxy === true,
	};
}

