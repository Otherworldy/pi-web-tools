import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SearchResult } from "./providers/types.js";

const CACHE_TTL_MS = 60 * 60 * 1000;
export const STORAGE_CUSTOM_TYPE = "web-tools-results";

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	outputPath?: string;
}

export interface QueryResultData {
	query: string;
	answer?: string;
	results: SearchResult[];
	error: string | null;
	provider?: string;
}

export interface StoredSearchData {
	id: string;
	type: "search" | "fetch" | "research";
	timestamp: number;
	queries?: QueryResultData[];
	urls?: ExtractedContent[];
	artifact?: unknown;
}

const storedResults = new Map<string, StoredSearchData>();

export function generateId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function storeResult(id: string, data: StoredSearchData): void {
	storedResults.set(id, data);
}

export function getResult(id: string): StoredSearchData | null {
	return storedResults.get(id) ?? null;
}

export function getAllResults(): StoredSearchData[] {
	return Array.from(storedResults.values()).sort((a, b) => b.timestamp - a.timestamp);
}

export function clearResults(): void {
	storedResults.clear();
}

function isValidStoredData(data: unknown): data is StoredSearchData {
	if (!data || typeof data !== "object") return false;
	const d = data as Record<string, unknown>;
	if (typeof d.id !== "string" || !d.id) return false;
	if (d.type !== "search" && d.type !== "fetch" && d.type !== "research") return false;
	if (typeof d.timestamp !== "number") return false;
	return true;
}

export function restoreFromSession(ctx: ExtensionContext): void {
	storedResults.clear();
	const now = Date.now();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === STORAGE_CUSTOM_TYPE) {
			const data = entry.data;
			if (isValidStoredData(data) && now - data.timestamp < CACHE_TTL_MS) {
				storedResults.set(data.id, data);
			}
		}
	}
}

export function sliceText(text: string, offset = 0, limit = 30_000): { text: string; offset: number; limit: number; total: number; hasMore: boolean } {
	const start = Math.max(0, Math.floor(offset));
	const size = Math.max(1, Math.floor(limit));
	const slice = text.slice(start, start + size);
	return {
		text: slice,
		offset: start,
		limit: size,
		total: text.length,
		hasMore: start + size < text.length,
	};
}
