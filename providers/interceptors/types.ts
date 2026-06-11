import type { FetchResponse } from "../types.js";

// Generic URL specialist contract. A UrlInterceptor inspects a fetch target
// before configured fetch-capable sources and the generic HTML fallback run;
// if it owns the URL it returns a FetchResponse, otherwise it returns null and
// the orchestrator falls through to the next interceptor/fallback.
// Cheap rejection (URL parse + host check) MUST be the common path so
// unrelated URLs don't pay for chain registration.
export interface UrlInterceptor {
	readonly name: string;
	intercept(url: string, opts: { raw: boolean; signal?: AbortSignal; forceClone?: boolean }): Promise<FetchResponse | null>;
}
