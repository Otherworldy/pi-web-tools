/**
 * pi-web-tools — Pi extension
 *
 * Registers one_search, web_fetch, get_search_content, source_check tools,
 * plus /web-tools, /search, /curator, /websearch, /activity commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildInterceptors } from "./providers/interceptors/index.js";
import {
	registerActivityAndCommands,
	registerGetSearchContentTool,
	registerSourceCheckTool,
	registerWebFetchTool,
	registerWebSearchConfigCommand,
	registerWebSearchTool,
} from "./web-tools.js";

export { createSearchProvider } from "./providers/factory.js";
export {
	GITHUB_TOKEN_ENV_VAR,
	GitHubInterceptor,
	type GitHubInterceptorOptions,
	type GitHubUrlInfo,
	parseGitHubUrl,
	resolveGitHubOptions,
	type UrlInterceptor,
} from "./providers/interceptors/index.js";

export type {
	FetchProvider,
	FetchResponse,
	FullProvider,
	SearchProvider,
	SearchResponse,
	SearchResult,
} from "./providers/types.js";
export {
	DEFAULT_WEB_FETCH_GUIDELINES,
	DEFAULT_WEB_FETCH_SNIPPET,
	DEFAULT_WEB_SEARCH_GUIDELINES,
	DEFAULT_WEB_SEARCH_SNIPPET,
	registerActivityAndCommands,
	registerGetSearchContentTool,
	registerSourceCheckTool,
	registerWebFetchTool,
	registerWebSearchConfigCommand,
	registerWebSearchTool,
} from "./web-tools.js";

export interface RegisterOptions {
	interceptors?: {
		github?: boolean;
	};
}

export default function registerWebTools(pi: ExtensionAPI, opts?: RegisterOptions): void {
	buildInterceptors(opts?.interceptors);
	registerWebSearchTool(pi);
	registerWebFetchTool(pi);
	registerGetSearchContentTool(pi);
	registerSourceCheckTool(pi);
	registerWebSearchConfigCommand(pi);
	registerActivityAndCommands(pi);
}
