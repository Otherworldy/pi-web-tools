import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createMockCtx, createMockPi, stubFetch } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it, type vi } from "vitest";
import registerWebTools from "./index.js";
import { configPath } from "./providers/config.js";
import {
	clearCloneCache,
	configureSearxng,
	GitHubInterceptor,
	OLLAMA_DEFAULT_URL,
	SEARXNG_DEFAULT_URL,
	SEARXNG_PROVIDER_META,
	SearxngProvider,
} from "./providers/index.js";

const CONFIG_PATH = configPath("rpiv-web-tools");

function registerAndCapture() {
	const { pi, captured } = createMockPi();
	registerWebTools(pi);
	return { pi, captured };
}

function writeConfig(contents: unknown) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(contents), "utf-8");
}

beforeEach(() => {
	clearCloneCache();
	delete process.env.BRAVE_SEARCH_API_KEY;
	delete process.env.TAVILY_API_KEY;
	delete process.env.SERPER_API_KEY;
	delete process.env.EXA_API_KEY;
	delete process.env.YOUCOM_API_KEY;
	delete process.env.JINA_API_KEY;
	delete process.env.FIRECRAWL_API_KEY;
	delete process.env.PERPLEXITY_API_KEY;
	delete process.env.SEARXNG_API_KEY;
	delete process.env.SEARXNG_URL;
	delete process.env.OLLAMA_API_KEY;
	delete process.env.OLLAMA_HOST;
	delete process.env.GITHUB_TOKEN;
	rmSync(CONFIG_PATH, { force: true });
});

describe("registerWebTools — registration", () => {
	it("registers web_search + web_fetch tools", () => {
		const { captured } = registerAndCapture();
		expect(captured.tools.has("web_search")).toBe(true);
		expect(captured.tools.has("web_fetch")).toBe(true);
	});

	it("registers /web-tools command", () => {
		const { captured } = registerAndCapture();
		expect(captured.commands.has("web-tools")).toBe(true);
	});

	it("web_fetch schema exposes forceClone for GitHub clone overrides", () => {
		const { captured } = registerAndCapture();
		const params = captured.tools.get("web_fetch")?.parameters as unknown as {
			properties: { forceClone: { type: string; default: boolean; description: string } };
		};
		expect(params.properties.forceClone).toMatchObject({ type: "boolean", default: false });
		expect(params.properties.forceClone.description).toContain("GitHub");
	});

	it("web_search schema declares merged-result minimum without a default or maximum", () => {
		const { captured } = registerAndCapture();
		const params = captured.tools.get("web_search")?.parameters as unknown as {
			properties: { max_results: { minimum: number; maximum?: number; default?: number; description: string } };
		};
		expect(params.properties.max_results).toMatchObject({ minimum: 1 });
		expect(params.properties.max_results.default).toBeUndefined();
		expect(params.properties.max_results.maximum).toBeUndefined();
		expect(params.properties.max_results.description).toContain("search.mergedResults (20)");
	});

	it("web_search schema references configured search.mergedResults without setting a schema default", () => {
		writeConfig({ search: { mergedResults: 30 } });
		const { captured } = registerAndCapture();
		const params = captured.tools.get("web_search")?.parameters as unknown as {
			properties: { max_results: { minimum: number; maximum?: number; default?: number; description: string } };
		};
		expect(params.properties.max_results).toMatchObject({ minimum: 1 });
		expect(params.properties.max_results.default).toBeUndefined();
		expect(params.properties.max_results.maximum).toBeUndefined();
		expect(params.properties.max_results.description).toContain("search.mergedResults (30)");
	});
});

const PROVIDER_MATRIX = [
	{
		provider: "brave",
		envVar: "BRAVE_SEARCH_API_KEY",
		urlMatcher: (u: string) => u.includes("api.search.brave.com"),
		buildResponse: () =>
			JSON.stringify({
				web: { results: [{ title: "T", url: "https://x", description: "snip" }] },
			}),
		emptyResponse: () => JSON.stringify({ web: { results: [] } }),
		authHeader: "X-Subscription-Token" as string | null,
	},
	{
		provider: "tavily",
		envVar: "TAVILY_API_KEY",
		urlMatcher: (u: string) => u.includes("api.tavily.com"),
		buildResponse: () => JSON.stringify({ results: [{ title: "T", url: "https://x", content: "snip" }] }),
		emptyResponse: () => JSON.stringify({ results: [] }),
		authHeader: null,
	},
	{
		provider: "serper",
		envVar: "SERPER_API_KEY",
		urlMatcher: (u: string) => u.includes("google.serper.dev"),
		buildResponse: () => JSON.stringify({ organic: [{ title: "T", link: "https://x", snippet: "snip" }] }),
		emptyResponse: () => JSON.stringify({ organic: [] }),
		authHeader: "X-API-KEY" as string | null,
	},
	{
		provider: "exa",
		envVar: "EXA_API_KEY",
		urlMatcher: (u: string) => u.includes("api.exa.ai"),
		buildResponse: () => JSON.stringify({ results: [{ title: "T", url: "https://x", text: "snip" }] }),
		emptyResponse: () => JSON.stringify({ results: [] }),
		authHeader: "x-api-key" as string | null,
	},
	{
		provider: "jina",
		envVar: "JINA_API_KEY",
		urlMatcher: (u: string) => u.includes("s.jina.ai"),
		buildResponse: () =>
			JSON.stringify({
				code: 200,
				status: 200,
				data: [{ title: "T", url: "https://x", description: "snip" }],
			}),
		emptyResponse: () => JSON.stringify({ code: 200, status: 200, data: [] }),
		authHeader: "Authorization" as string | null,
	},
	{
		provider: "firecrawl",
		envVar: "FIRECRAWL_API_KEY",
		urlMatcher: (u: string) => u.includes("api.firecrawl.dev"),
		buildResponse: () =>
			JSON.stringify({
				success: true,
				data: [{ title: "T", url: "https://x", description: "snip" }],
			}),
		emptyResponse: () => JSON.stringify({ success: true, data: [] }),
		authHeader: "Authorization" as string | null,
	},
	{
		provider: "perplexity",
		envVar: "PERPLEXITY_API_KEY",
		urlMatcher: (u: string) => u.includes("api.perplexity.ai"),
		buildResponse: () => JSON.stringify({ results: [{ title: "T", url: "https://x", snippet: "snip" }] }),
		emptyResponse: () => JSON.stringify({ results: [] }),
		authHeader: "Authorization" as string | null,
	},
] as const;

describe.each(PROVIDER_MATRIX)("web_search.execute — $provider", ({
	provider,
	envVar,
	urlMatcher,
	buildResponse,
	emptyResponse,
	authHeader,
}) => {
	it(`uses env key for ${provider}`, async () => {
		process.env[envVar] = "env-key";
		writeConfig({ search: { sources: { [provider]: {} } } });
		const stub = stubFetch([
			{
				match: urlMatcher,
				response: () => new Response(buildResponse(), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello", max_results: 3 }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ type: "text" });
		if (authHeader) {
			const headers = stub.calls[0].init?.headers as Record<string, string>;
			const headerVal = headers[authHeader];
			if (provider === "jina" || provider === "firecrawl" || provider === "perplexity") {
				expect(headerVal).toBe("Bearer env-key");
			} else {
				expect(headerVal).toBe("env-key");
			}
		} else {
			const body = JSON.parse(stub.calls[0].init?.body as string);
			expect(body.api_key).toBe("env-key");
		}
	});

	it(`falls back to config key for ${provider}`, async () => {
		writeConfig({ search: { sources: { [provider]: { apiKey: "config-key" } } } });
		const stub = stubFetch([
			{
				match: urlMatcher,
				response: () => new Response(buildResponse(), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		if (authHeader) {
			const headers = stub.calls[0].init?.headers as Record<string, string>;
			const headerVal = headers[authHeader];
			if (provider === "jina" || provider === "firecrawl" || provider === "perplexity") {
				expect(headerVal).toBe("Bearer config-key");
			} else {
				expect(headerVal).toBe("config-key");
			}
		} else {
			const body = JSON.parse(stub.calls[0].init?.body as string);
			expect(body.api_key).toBe("config-key");
		}
	});

	it(`throws when no key configured for ${provider}`, async () => {
		writeConfig({ search: { sources: { [provider]: {} } } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(new RegExp(`${envVar} is not set`));
	});

	it(`returns no-results envelope for ${provider}`, async () => {
		process.env[envVar] = "k";
		writeConfig({ search: { sources: { [provider]: {} } } });
		stubFetch([
			{
				match: urlMatcher,
				response: () => new Response(emptyResponse(), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("No results found") });
	});

	it(`wraps non-2xx as '${provider} Search API error (status)'`, async () => {
		const label = provider.charAt(0).toUpperCase() + provider.slice(1);
		process.env[envVar] = "k";
		writeConfig({ search: { sources: { [provider]: {} } } });
		stubFetch([
			{
				match: urlMatcher,
				response: () => new Response("rate limit", { status: 429 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(new RegExp(`${label} Search API error \\(429\\)`));
	});
});

describe("web_search.execute — source-independent behavior", () => {
	it("uses the built-in per-source default result count", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const url = stub.calls[0].url;
		expect(new URL(url).searchParams.get("count")).toBe("10");
	});

	it("uses configured search.defaultResults as the per-source request count", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { defaultResults: 99 } });
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).searchParams.get("count")).toBe("99");
	});

	it("source resultLimit overrides configured search.defaultResults", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { defaultResults: 8, sources: { brave: { resultLimit: 3 } } } });
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).searchParams.get("count")).toBe("3");
	});

	it("uses configured search.mergedResults when max_results is omitted", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { mergedResults: 30 } });
		stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () => new Response(JSON.stringify({ web: { results: [] } }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools.get("web_search")?.execute?.(
			"tc",
			{ query: "x" },
			undefined as never,
			undefined as never,
			createMockCtx(),
		);
		expect((r?.details as { mergedResultLimit: number }).mergedResultLimit).toBe(30);
	});

	it("uses env-configured brave as a search source", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () =>
					new Response(
						JSON.stringify({
							web: { results: [{ title: "T", url: "https://x", description: "snip" }] },
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { backend: string }).backend).toBe("brave");
		expect(stub.calls[0].url).toContain("api.search.brave.com");
	});

	it("throws setup guidance when no search source is configured", async () => {
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/No search sources configured/);
	});

	it("treats empty-string env key as unset", async () => {
		process.env.EXA_API_KEY = "";
		writeConfig({ search: { sources: { exa: { apiKey: "" } } } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/EXA_API_KEY is not set/);
	});

	it("treats empty-string legacy brave apiKey as unset", async () => {
		writeConfig({ search: { sources: { brave: { apiKey: "   " } } } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/BRAVE_SEARCH_API_KEY is not set/);
	});

	it("uses legacy apiKey fallback for brave", async () => {
		writeConfig({ apiKey: "legacy-key" });
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () =>
					new Response(
						JSON.stringify({
							web: { results: [{ title: "T", url: "https://x", description: "snip" }] },
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers["X-Subscription-Token"]).toBe("legacy-key");
	});

	it("searches configured sources concurrently and merges unique URLs", async () => {
		writeConfig({
			search: {
				sources: {
					brave: { apiKey: "brave-key" },
					tavily: { apiKey: "tavily-key" },
					serper: { apiKey: "serper-key" },
				},
			},
		});
		const stub = stubFetch([
			{
				match: (u) => u.includes("api.tavily.com"),
				response: () =>
					new Response(
						JSON.stringify({
							results: [
								{ title: "Tavily A", url: "https://shared.example/page#frag", content: "from tavily" },
								{ title: "Tavily B", url: "https://tavily.example/only", content: "unique tavily" },
							],
						}),
						{ status: 200 },
					),
			},
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () =>
					new Response(
						JSON.stringify({
							web: {
								results: [
									{ title: "Brave Duplicate", url: "https://shared.example/page", description: "dupe" },
									{ title: "Brave Unique", url: "https://brave.example/only", description: "unique brave" },
								],
							},
						}),
						{ status: 200 },
					),
			},
			{
				match: (u) => u.includes("google.serper.dev"),
				response: () =>
					new Response(
						JSON.stringify({
							organic: [{ title: "Serper Unique", link: "https://serper.example/only", snippet: "unique serper" }],
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x", max_results: 10 }, undefined as never, undefined as never, createMockCtx());
		const details = r?.details as {
			backend: string;
			backends: string[];
			sourceResultLimits: Record<string, number>;
			sourceResultCounts: Record<string, number>;
			mergedResultLimit: number;
			results: Array<{ title: string; url: string; source?: string }>;
		};
		expect(stub.calls).toHaveLength(3);
		expect(details.backend).toBe("brave,tavily,serper");
		expect(details.backends).toEqual(["brave", "tavily", "serper"]);
		expect(details.sourceResultLimits).toEqual({ brave: 10, tavily: 10, serper: 10 });
		expect(details.sourceResultCounts).toEqual({ brave: 2, tavily: 2, serper: 1 });
		expect(details.mergedResultLimit).toBe(10);
		expect(details.results.map((result) => result.title)).toEqual([
			"Brave Duplicate",
			"Tavily B",
			"Serper Unique",
			"Brave Unique",
		]);
		expect(details.results.map((result) => result.source)).toEqual(["brave", "tavily", "serper", "brave"]);
	});

	it("round-robins results so one source cannot fill the whole merged count", async () => {
		writeConfig({
			search: {
				defaultResults: 4,
				sources: {
					brave: { apiKey: "brave-key" },
					tavily: { apiKey: "tavily-key" },
				},
			},
		});
		stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () =>
					new Response(
						JSON.stringify({
							web: {
								results: [
									{ title: "Brave 1", url: "https://brave.example/1", description: "b1" },
									{ title: "Brave 2", url: "https://brave.example/2", description: "b2" },
									{ title: "Brave 3", url: "https://brave.example/3", description: "b3" },
								],
							},
						}),
						{ status: 200 },
					),
			},
			{
				match: (u) => u.includes("api.tavily.com"),
				response: () =>
					new Response(
						JSON.stringify({ results: [{ title: "Tavily 1", url: "https://tavily.example/1", content: "t1" }] }),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x", max_results: 3 }, undefined as never, undefined as never, createMockCtx());
		const details = r?.details as {
			sourceResultLimits: Record<string, number>;
			sourceResultCounts: Record<string, number>;
			mergedResultLimit: number;
			results: Array<{ title: string; source?: string }>;
		};
		expect(details.sourceResultLimits).toEqual({ brave: 4, tavily: 4 });
		expect(details.sourceResultCounts).toEqual({ brave: 3, tavily: 1 });
		expect(details.mergedResultLimit).toBe(3);
		expect(details.results.map((result) => result.title)).toEqual(["Brave 1", "Tavily 1", "Brave 2"]);
		expect(details.results.map((result) => result.source)).toEqual(["brave", "tavily", "brave"]);
	});

	it("keeps successful source results when another source fails", async () => {
		writeConfig({
			search: {
				sources: {
					brave: { apiKey: "brave-key" },
					serper: { apiKey: "serper-key" },
				},
			},
		});
		stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () =>
					new Response(
						JSON.stringify({ web: { results: [{ title: "Brave", url: "https://brave.example", description: "ok" }] } }),
						{ status: 200 },
					),
			},
			{
				match: (u) => u.includes("google.serper.dev"),
				response: () => new Response("rate limit", { status: 429 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const text = (r?.content[0] as { text: string }).text;
		const details = r?.details as { failures: string[]; results: Array<{ title: string }> };
		expect(details.results).toHaveLength(1);
		expect(details.failures[0]).toContain("serper: Serper Search API error (429)");
		expect(text).toContain("Search source warnings");
	});
});

describe("web_fetch.execute — URL validation", () => {
	it("throws on invalid URL", async () => {
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "not a url" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Invalid URL/);
	});
	it("throws on non-http(s) protocol", async () => {
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "ftp://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Unsupported URL protocol/);
	});

	it.each([
		"http://localhost/",
		"http://127.0.0.1/",
		"http://169.254.169.254/latest/meta-data/",
		"http://10.0.0.1/",
		"http://192.168.1.1/",
		"http://172.16.0.1/",
		"http://[::1]/",
	])("refuses private/loopback host %s", async (url) => {
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/private\/loopback/);
	});

	// The previous it.each does not need a configured source. SearXNG is
	// structurally interesting because its baseUrl is allowed to point at
	// loopback (self-hosted) — that exemption must NOT leak to web_fetch, which
	// retrieves arbitrary URLs returned by search. The guard sits in
	// parseAndAssertHttpUrl *before* the provider is consulted, so it should
	// still fire when searxng is configured.
	it("refuses private/loopback host when configured source is searxng", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: "http://localhost:8080" } } } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "http://127.0.0.1/secret" },
					undefined as never,
					undefined as never,
					createMockCtx(),
				),
		).rejects.toThrow(/private\/loopback/);
	});
});

describe("web_fetch.execute — happy path", () => {
	it("strips HTML and extracts title for text/html", async () => {
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () =>
					new Response("<html><head><title>My Page</title></head><body><p>Hello</p></body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("My Page") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Hello") });
	});

	it("throws on non-2xx with HTTP status in message", async () => {
		stubFetch([
			{
				match: () => true,
				response: () => new Response("nope", { status: 404, statusText: "Not Found" }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/HTTP 404/);
	});

	it("throws on binary content-type", async () => {
		stubFetch([
			{
				match: () => true,
				response: () => new Response("binary", { status: 200, headers: { "content-type": "image/png" } }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Unsupported content type/);
	});

	it("returns raw=true untouched", async () => {
		stubFetch([
			{
				match: () => true,
				response: () => new Response("<p>raw</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://x.com", raw: true },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("<p>raw</p>") });
	});

	it("sends UA + Accept headers + redirect:follow", async () => {
		const stub = stubFetch([
			{
				match: () => true,
				response: () => new Response("<p>x</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		const init = stub.calls[0].init;
		const headers = init?.headers as Record<string, string>;
		expect(headers["User-Agent"]).toMatch(/rpiv-pi/);
		expect(headers.Accept).toContain("text/html");
		expect(init?.redirect).toBe("follow");
	});

	it("coerces content-length to numeric details.contentLength", async () => {
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("x".repeat(100), {
						status: 200,
						headers: { "content-type": "text/plain", "content-length": "100" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { contentLength: number }).contentLength).toBe(100);
	});

	it("falls back to defaults when config file is malformed JSON", async () => {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, "not valid json {", "utf-8");
		stubFetch([
			{
				match: () => true,
				response: () => new Response("<p>hi</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.content[0] as { text: string }).text).toContain("hi");
	});

	it("decodes numeric HTML entities in text/html bodies", async () => {
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<p>&#65;&#66;&#67;</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.content[0] as { text: string }).text).toContain("ABC");
	});

	it("spills full body to temp file and appends truncation footer when truncated", async () => {
		const fullBody = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
		stubFetch([
			{
				match: () => true,
				response: () => new Response(fullBody, { status: 200, headers: { "content-type": "text/plain" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://big.com" }, undefined as never, undefined as never, createMockCtx());

		const text = (r?.content[0] as { text: string }).text;
		expect(text).toContain("Content truncated:");
		expect(text).toContain("Full content saved to:");

		const details = r?.details as {
			truncation?: { truncated: boolean; totalLines: number };
			fullOutputPath?: string;
		};
		expect(details.truncation?.truncated).toBe(true);
		expect(details.truncation?.totalLines).toBe(3000);
		expect(details.fullOutputPath).toBeDefined();
		const spilled = readFileSync(details.fullOutputPath!, "utf-8");
		expect(spilled).toBe(fullBody);
	});
});

// Extraction providers — those with native fetch endpoints. Each entry drives
// the per-provider error-path assertions below: no-key throw + labeled non-2xx.
// Search-only providers (Brave/Serper/SearXNG) no longer have their own fetch()
// after the role split; their fallback path is asserted once in the
// "search-only providers fall back to generic HTML fetch" block.
const FETCH_ERROR_MATRIX: ReadonlyArray<{
	provider: string;
	envVar: string;
	fetchUrlMatcher: (u: string) => boolean;
	label: string;
}> = [
	{
		provider: "tavily",
		envVar: "TAVILY_API_KEY",
		fetchUrlMatcher: (u) => u.includes("api.tavily.com/extract"),
		label: "Tavily",
	},
	{ provider: "exa", envVar: "EXA_API_KEY", fetchUrlMatcher: (u) => u.includes("api.exa.ai/contents"), label: "Exa" },
	{ provider: "jina", envVar: "JINA_API_KEY", fetchUrlMatcher: (u) => u.includes("r.jina.ai"), label: "Jina" },
	{
		provider: "firecrawl",
		envVar: "FIRECRAWL_API_KEY",
		fetchUrlMatcher: (u) => u.includes("api.firecrawl.dev/v1/scrape"),
		label: "Firecrawl",
	},
	{
		provider: "youcom",
		envVar: "YOUCOM_API_KEY",
		fetchUrlMatcher: (u) => u.includes("ydc-index.io/v1/contents"),
		label: "You.com",
	},
];

describe.each(FETCH_ERROR_MATRIX)("web_fetch.execute — $provider error paths", ({
	provider,
	envVar,
	fetchUrlMatcher,
	label,
}) => {
	it(`fetch throws when no key configured for ${provider}`, async () => {
		writeConfig({ search: { sources: { [provider]: {} } } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(new RegExp(`${envVar} is not set`));
	});

	it(`fetch wraps non-2xx as '${label} Fetch API error (429)'`, async () => {
		process.env[envVar] = "k";
		writeConfig({ search: { sources: { [provider]: {} } } });
		stubFetch([
			{
				match: fetchUrlMatcher,
				response: () => new Response("rate limit", { status: 429 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(new RegExp(`${label} Fetch API error \\(429\\)`));
	});
});

// Brave/Serper/SearXNG are SearchProvider-only after the role split: the
// orchestrator falls through to `fetchViaGenericHtml`. The dispatch is
// provider-agnostic — one assertion per behavior is enough.
describe.each([
	{ provider: "brave", envVar: "BRAVE_SEARCH_API_KEY" },
	{ provider: "serper", envVar: "SERPER_API_KEY" },
	{ provider: "searxng", envVar: "SEARXNG_API_KEY" },
	{ provider: "perplexity", envVar: "PERPLEXITY_API_KEY" },
])("web_fetch.execute — $provider falls back to generic HTML", ({ provider, envVar }) => {
	it("does not throw on missing key (raw HTTP doesn't authenticate to the target)", async () => {
		writeConfig({ search: { sources: { [provider]: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () => new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("ok") });
	});

	it("wraps non-2xx as generic HTTP error from fetchViaGenericHtml", async () => {
		process.env[envVar] = "k";
		writeConfig({ search: { sources: { [provider]: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () => new Response("rate limit", { status: 429 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/HTTP 429/);
	});
});

describe("web_fetch.execute — provider fetch", () => {
	it("brave fetch strips HTML and extracts title", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () =>
					new Response("<html><head><title>My Page</title></head><body><p>Hello</p></body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("My Page") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Hello") });
	});

	it("brave fetch returns raw HTML when raw=true", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } } });
		stubFetch([
			{
				match: () => true,
				response: () => new Response("<p>raw</p>", { status: 200, headers: { "content-type": "text/html" } }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://x.com", raw: true },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("<p>raw</p>") });
	});

	it("tavily fetch uses /extract endpoint", async () => {
		process.env.TAVILY_API_KEY = "k";
		writeConfig({ search: { sources: { tavily: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("api.tavily.com/extract"),
				response: () =>
					new Response(JSON.stringify({ results: [{ url: "https://x.com", raw_content: "extracted text" }] }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("extracted text") });
	});

	it("tavily fetch handles failed_results", async () => {
		process.env.TAVILY_API_KEY = "k";
		writeConfig({ search: { sources: { tavily: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("api.tavily.com/extract"),
				response: () =>
					new Response(
						JSON.stringify({
							results: [],
							failed_results: [{ url: "https://x.com", error: "timeout" }],
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/extraction failed/);
	});

	it("exa fetch uses /contents endpoint", async () => {
		process.env.EXA_API_KEY = "k";
		writeConfig({ search: { sources: { exa: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("api.exa.ai/contents"),
				response: () =>
					new Response(
						JSON.stringify({
							results: [{ title: "Page", url: "https://x.com", text: "extracted content" }],
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("extracted content") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Page") });
	});

	it("exa fetch throws when no content returned", async () => {
		process.env.EXA_API_KEY = "k";
		writeConfig({ search: { sources: { exa: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("api.exa.ai/contents"),
				response: () => new Response(JSON.stringify({ results: [{ url: "https://x.com" }] }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/no content returned/);
	});

	it("jina fetch throws when response body is empty", async () => {
		process.env.JINA_API_KEY = "k";
		writeConfig({ search: { sources: { jina: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("r.jina.ai"),
				response: () => new Response("", { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/no content returned/);
	});

	it("jina fetch uses r.jina.ai reader", async () => {
		process.env.JINA_API_KEY = "k";
		writeConfig({ search: { sources: { jina: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("r.jina.ai"),
				response: () => new Response("extracted markdown content", { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("extracted markdown content") });
	});

	it("firecrawl fetch uses /v1/scrape endpoint", async () => {
		process.env.FIRECRAWL_API_KEY = "k";
		writeConfig({ search: { sources: { firecrawl: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("api.firecrawl.dev/v1/scrape"),
				response: () =>
					new Response(
						JSON.stringify({
							success: true,
							data: { markdown: "# Title\nPage content", metadata: { title: "Scraped Page" } },
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Page content") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Scraped Page") });
	});

	it("firecrawl fetch throws on success=true with empty markdown", async () => {
		process.env.FIRECRAWL_API_KEY = "k";
		writeConfig({ search: { sources: { firecrawl: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("api.firecrawl.dev/v1/scrape"),
				response: () =>
					new Response(JSON.stringify({ success: true, data: { metadata: { title: "T" } } }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/no content returned/);
	});

	it("firecrawl fetch handles success=false", async () => {
		process.env.FIRECRAWL_API_KEY = "k";
		writeConfig({ search: { sources: { firecrawl: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("api.firecrawl.dev/v1/scrape"),
				response: () => new Response(JSON.stringify({ success: false }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://x.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/scrape failed/);
	});

	it("extraction providers (jina) ignore raw and never strip vendor body", async () => {
		// Contract: Jina/Firecrawl/Tavily/Exa always return what their extraction
		// API gave us. raw=true must NOT trigger the htmlToText pipeline that
		// Brave/Serper run. Stub a body containing literal HTML tags and assert
		// they survive in the output (i.e. no stripping happened).
		process.env.JINA_API_KEY = "k";
		writeConfig({ search: { sources: { jina: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("r.jina.ai"),
				response: () => new Response("# heading\n<p>vendor markdown</p>", { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://x.com", raw: true },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		// If raw=true had triggered htmlToText, the <p> tag would be gone.
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("<p>vendor markdown</p>") });
	});

	// Branch coverage for Brave/Serper fetch(): the ?? "" content-type fallback,
	// the "" -> undefined contentType collapse, and the undefined contentLength
	// path when the response omits the header.
	describe.each([
		{ provider: "brave", envVar: "BRAVE_SEARCH_API_KEY" },
		{ provider: "serper", envVar: "SERPER_API_KEY" },
	])("$provider fetch — header fallbacks", ({ provider, envVar }) => {
		it("returns undefined contentType/contentLength when headers are absent", async () => {
			process.env[envVar] = "k";
			writeConfig({ search: { sources: { [provider]: {} } } });
			stubFetch([
				{
					match: (u) => u.includes("example.com"),
					// Blob with empty type stops Response from auto-deriving a content-type,
					// so res.headers.get("content-type") returns null. content-length is
					// likewise omitted unless we set it.
					response: () => new Response(new Blob(["plain body"], { type: "" }), { status: 200 }),
				},
			]);
			const { captured } = registerAndCapture();
			const r = await captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "https://example.com", raw: true },
					undefined as never,
					undefined as never,
					createMockCtx(),
				);
			// toMatchObject treats `undefined` as "key absent or undefined", so use
			// hasOwnProperty + direct equality to assert both.
			const details = r?.details as Record<string, unknown> | undefined;
			expect(details?.contentType).toBeUndefined();
			expect(details?.contentLength).toBeUndefined();
		});

		it("parses Number(contentLength) when the header is present", async () => {
			process.env[envVar] = "k";
			writeConfig({ search: { sources: { [provider]: {} } } });
			stubFetch([
				{
					match: (u) => u.includes("example.com"),
					response: () =>
						new Response("plain body", {
							status: 200,
							headers: { "content-type": "text/plain", "content-length": "10" },
						}),
				},
			]);
			const { captured } = registerAndCapture();
			const r = await captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "https://example.com", raw: true },
					undefined as never,
					undefined as never,
					createMockCtx(),
				);
			expect(r?.details).toMatchObject({ contentType: "text/plain", contentLength: 10 });
		});
	});

	// Branch coverage for normalizeBraveResults: each result field is null-coalesced
	// to "" so a partial vendor row (missing title/url/description) must not throw
	// and must round-trip as empty strings.
	it("brave search tolerates missing fields in organic results", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("api.search.brave.com"),
				response: () => new Response(JSON.stringify({ web: { results: [{}] } }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		// Empty fields land as empty strings, not crashes.
		expect(r?.details).toMatchObject({ results: [{ title: "", url: "", snippet: "" }] });
	});

	// Branch coverage for normalizeSerperResults: same shape as Brave above.
	it("serper search tolerates missing fields in organic results", async () => {
		process.env.SERPER_API_KEY = "k";
		writeConfig({ search: { sources: { serper: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("google.serper.dev"),
				response: () => new Response(JSON.stringify({ organic: [{}] }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.details).toMatchObject({ results: [{ title: "", url: "", snippet: "" }] });
	});
});

describe("config round-trip with all sources", () => {
	it("preserves keys for all sources when updating one source", async () => {
		writeConfig({
			search: {
				sources: {
					brave: { apiKey: "brave-key" },
					tavily: { apiKey: "tavily-key" },
					jina: { apiKey: "jina-key" },
					firecrawl: { apiKey: "firecrawl-key" },
				},
			},
		});
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Firecrawl");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-firecrawl-key");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.brave.apiKey).toBe("brave-key");
		expect(saved.search.sources.tavily.apiKey).toBe("tavily-key");
		expect(saved.search.sources.jina.apiKey).toBe("jina-key");
		expect(saved.search.sources.firecrawl.apiKey).toBe("new-firecrawl-key");
		expect(saved.provider).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
	});
});

describe("/web-tools command", () => {
	it("!hasUI notifies error", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: false });
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
	});

	it("show displays all sources with masked keys", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "sk-live-abcdefghijklmnop";
		writeConfig({ search: { defaultResults: 8, sources: { brave: { apiKey: "sk-cfg-abcdefghijklmnop" } } } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("sk-l...mnop");
		expect(msg).toContain("sk-c...mnop");
		expect(msg).toContain("brave: configured");
		expect(msg).not.toContain("active provider");
		expect(msg).toContain("default per-source results: 8");
		expect(msg).toContain("merged result count: 20");
		expect(msg).toContain("requestLimit=8");
	});

	it("show shows '(not set)' when nothing configured", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("(not set)");
		expect(msg).toContain("default per-source results: 10");
		expect(msg).toContain("merged result count: 20");
	});

	it("default-results persists the default per-source result count", async () => {
		writeConfig({ search: { sources: { brave: { apiKey: "brave-key" } } } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("default-results 8", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.brave.apiKey).toBe("brave-key");
		expect(saved.search.defaultResults).toBe(8);
		expect(saved.provider).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
		expect(saved.defaultSearchResults).toBeUndefined();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("8"), "info");
	});

	it("default-results rejects non-integer input", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("default-results nope", ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("integer"), "error");
	});

	it("default-results accepts large positive integers", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("default-results 99", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.defaultResults).toBe(99);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("99"), "info");
	});

	it("merged-results persists the merged result count", async () => {
		writeConfig({ search: { defaultResults: 8 } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("merged-results 35", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.defaultResults).toBe(8);
		expect(saved.search.mergedResults).toBe(35);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("35"), "info");
	});

	it("source-results persists an individual source request count", async () => {
		writeConfig({ search: { sources: { exa: { apiKey: "exa-key" } } } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("source-results exa 7", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.exa.apiKey).toBe("exa-key");
		expect(saved.search.sources.exa.resultLimit).toBe(7);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("7"), "info");
	});

	it("two-step: select source then enter key", async () => {
		writeConfig({ apiKey: "old", otherField: "keep" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Tavily");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("  tavily-key  ");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved).toEqual({
			search: {
				sources: {
					brave: { apiKey: "old" },
					tavily: { apiKey: "tavily-key" },
				},
			},
			otherField: "keep",
		});
		expect(saved.apiKey).toBeUndefined();
		expect(saved.provider).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
	});

	it("select cancelled leaves config untouched", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.apiKey).toBe("existing");
	});

	it("input cancelled after select leaves config untouched", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Serper");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.apiKey).toBe("existing");
	});

	it("empty input after select leaves config semantically untouched when no existing key", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		// Selecting Exa: no search.sources.exa, no env var, legacy apiKey only applies to brave.
		// existingKey for Exa = undefined, so empty input falls through to cancel.
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Exa");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("   ");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.brave.apiKey).toBe("existing");
		expect(saved.apiKey).toBeUndefined();
		expect(saved.provider).toBeUndefined();
	});

	it("empty input keeps existing source key", async () => {
		writeConfig({ search: { sources: { brave: { apiKey: "brave-key" }, exa: { apiKey: "exa-key" } } } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Exa");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.exa.apiKey).toBe("exa-key");
		expect(saved.search.sources.brave.apiKey).toBe("brave-key");
		expect(saved.provider).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
	});

	it("migrates legacy apiKey to search.sources on save", async () => {
		writeConfig({ apiKey: "legacy-key", otherField: "keep" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Brave");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-key");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.brave.apiKey).toBe("new-key");
		expect(saved.provider).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
		expect(saved.apiKey).toBeUndefined();
		expect(saved.otherField).toBe("keep");
	});

	it("lists sources without an active-source marker", async () => {
		writeConfig({ search: { sources: { exa: { apiKey: "exa-key" } } } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Exa (configured)");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-exa-key");
		await captured.commands.get("web-tools")?.handler("", ctx as never);

		const selectCall = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
		const labels = selectCall[1] as string[];
		expect(labels).toEqual([
			"Brave",
			"Tavily",
			"Serper",
			"Exa (configured)",
			"You.com",
			"Jina",
			"Firecrawl",
			"Perplexity",
			"SearXNG",
			"Ollama",
		]);
		expect(labels.some((l) => l.includes("✓"))).toBe(false);

		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.exa.apiKey).toBe("new-exa-key");
		expect(saved.provider).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
	});

	it("marks every source with a saved key as (configured)", async () => {
		writeConfig({
			search: {
				sources: {
					exa: { apiKey: "exa-key" },
					brave: { apiKey: "brave-key" },
					tavily: { apiKey: "tavily-key" },
				},
			},
		});
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
		expect(labels).toContain("Exa (configured)");
		expect(labels).toContain("Brave (configured)");
		expect(labels).toContain("Tavily (configured)");
		expect(labels).toContain("Serper");
		expect(labels).toContain("Jina");
		expect(labels).toContain("Firecrawl");
	});

	it("marks source as (configured) when key is in env var", async () => {
		process.env.JINA_API_KEY = "env-jina-key";
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
		expect(labels).toContain("Jina (configured)");
	});

	it("lists registry order when no source is configured", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
		expect(labels[0]).toBe("Brave");
		expect(labels.some((l) => l.includes("✓"))).toBe(false);
	});

	it("notifies error and skips 'Saved …' when the underlying write fails", async () => {
		// Force saveJsonConfig to fail by placing a directory at CONFIG_PATH so
		// writeFileSync throws EISDIR. This drives the same control flow that disk
		// full / EACCES / EROFS would in production.
		if (process.platform === "win32") return;
		mkdirSync(CONFIG_PATH, { recursive: true });
		try {
			const { captured } = registerAndCapture();
			const ctx = createMockCtx({ hasUI: true });
			(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Brave");
			(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("new-key");
			await captured.commands.get("web-tools")?.handler("", ctx as never);

			const notifyMock = ctx.ui.notify as ReturnType<typeof vi.fn>;
			const calls = notifyMock.mock.calls;
			expect(calls.some(([msg, level]) => /Failed to save/.test(String(msg)) && level === "error")).toBe(true);
			expect(calls.some(([msg]) => /^Saved /.test(String(msg)))).toBe(false);
		} finally {
			rmSync(CONFIG_PATH, { recursive: true, force: true });
		}
	});
});

// SearXNG is structurally unlike the six hosted providers: it is self-hosted
// (needs a base URL), API key is optional (only for proxy-fronted instances),
// and the JSON API exposes no `count` parameter. Kept out of PROVIDER_MATRIX
// because the "throws when no key" assumption doesn't hold.
describe("web_search.execute — searxng", () => {
	const SEARXNG_OK_BODY = JSON.stringify({
		results: [
			{ title: "T1", url: "https://result.example/1", content: "snippet 1" },
			{ title: "T2", url: "https://result.example/2", content: "snippet 2" },
		],
	});

	it("uses env URL (wins over config and default)", async () => {
		process.env.SEARXNG_URL = "http://env-host:9000";
		writeConfig({ search: { sources: { searxng: { baseUrl: "http://config-host:7000" } } } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://env-host:9000/"),
				response: () => new Response(SEARXNG_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello" }, undefined as never, undefined as never, createMockCtx());
		const url = new URL(stub.calls[0].url);
		expect(`${url.protocol}//${url.host}`).toBe("http://env-host:9000");
		expect(url.pathname).toBe("/search");
		expect(url.searchParams.get("q")).toBe("hello");
		expect(url.searchParams.get("format")).toBe("json");
		expect(url.searchParams.get("safesearch")).toBe("0");
		expect(url.searchParams.has("count")).toBe(false);
	});

	it("falls back to config URL when env is unset", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: "http://config-host:7000" } } } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://config-host:7000/"),
				response: () => new Response(SEARXNG_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).host).toBe("config-host:7000");
	});

	it("uses configured default SearXNG URL when selected without a custom URL", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: SEARXNG_DEFAULT_URL } } } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://localhost:8080/"),
				response: () => new Response(SEARXNG_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).host).toBe("localhost:8080");
	});

	it("trailing slash on baseUrl does not produce a double-slash", async () => {
		process.env.SEARXNG_URL = "http://host:8080/";
		const stub = stubFetch([
			{ match: (u) => u.includes("host:8080"), response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(stub.calls[0].url).not.toMatch(/\/\/search/);
		expect(new URL(stub.calls[0].url).pathname).toBe("/search");
	});

	it("multiple trailing slashes on baseUrl are all stripped", async () => {
		process.env.SEARXNG_URL = "http://host:8080///";
		const stub = stubFetch([
			{ match: (u) => u.includes("host:8080"), response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(stub.calls[0].url).not.toMatch(/\/\/search/);
		expect(new URL(stub.calls[0].url).pathname).toBe("/search");
	});

	it("sends Bearer Authorization only when an API key is configured", async () => {
		process.env.SEARXNG_API_KEY = "env-bearer";
		writeConfig({ search: { sources: { searxng: { baseUrl: SEARXNG_DEFAULT_URL } } } });
		const stub = stubFetch([{ match: () => true, response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer env-bearer");
	});

	it("omits Authorization when no API key is configured", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: SEARXNG_DEFAULT_URL } } } });
		const stub = stubFetch([{ match: () => true, response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("falls back to search.sources.searxng.apiKey when env is unset", async () => {
		writeConfig({ search: { sources: { searxng: { apiKey: "config-bearer" } } } });
		const stub = stubFetch([{ match: () => true, response: () => new Response(SEARXNG_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer config-bearer");
	});

	it("slices results to max_results", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: SEARXNG_DEFAULT_URL } } } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response(
						JSON.stringify({
							results: Array.from({ length: 8 }, (_, i) => ({
								title: `T${i}`,
								url: `https://r/${i}`,
								content: `snip ${i}`,
							})),
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x", max_results: 3 }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { results: Array<{ title: string; url: string; snippet: string }> }).results).toHaveLength(
			3,
		);
	});

	it("returns no-results envelope on empty results array", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: SEARXNG_DEFAULT_URL } } } });
		stubFetch([
			{ match: () => true, response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("No results found") });
	});

	it("wraps non-2xx as 'SearXNG Search API error (status)'", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: SEARXNG_DEFAULT_URL } } } });
		stubFetch([{ match: () => true, response: () => new Response("oops", { status: 500 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/SearXNG Search API error \(500\)/);
	});

	it("403 attaches the 'JSON output may be disabled' hint", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: SEARXNG_DEFAULT_URL } } } });
		stubFetch([{ match: () => true, response: () => new Response("forbidden", { status: 403 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/JSON output disabled/);
	});

	it("401 attaches the 'reverse-proxy rejected the Bearer token' hint", async () => {
		writeConfig({ search: { sources: { searxng: { apiKey: "bad-bearer" } } } });
		stubFetch([{ match: () => true, response: () => new Response("unauthorized", { status: 401 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/rejected the Bearer token.*SEARXNG_API_KEY/);
	});

	it("normalizes missing fields on result rows to empty strings", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: SEARXNG_DEFAULT_URL } } } });
		stubFetch([
			{ match: () => true, response: () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.details).toMatchObject({ results: [{ title: "", url: "", snippet: "" }] });
	});
});

describe("/web-tools command — searxng", () => {
	it("prompts URL first, then optional key, and persists both", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("SearXNG");
		const inputMock = ctx.ui.input as ReturnType<typeof vi.fn>;
		inputMock.mockResolvedValueOnce("http://my-searx:8080").mockResolvedValueOnce("my-bearer");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved).toMatchObject({
			search: {
				sources: {
					searxng: { baseUrl: "http://my-searx:8080", apiKey: "my-bearer" },
				},
			},
		});
		expect(saved.provider).toBeUndefined();
		expect(saved.baseUrls).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
		// Two input prompts: URL first, then API key
		expect(inputMock.mock.calls).toHaveLength(2);
		expect(String(inputMock.mock.calls[0][0])).toMatch(/URL/i);
		expect(String(inputMock.mock.calls[1][0])).toMatch(/key/i);
	});

	it("empty URL input falls back to the default URL and leaves key unset", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("SearXNG");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("").mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.searxng.baseUrl).toBe("http://localhost:8080");
		expect(saved.search.sources.searxng.apiKey).toBeUndefined();
		expect(saved.provider).toBeUndefined();
		expect(saved.baseUrls).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
	});

	it("URL cancel (undefined) leaves config untouched", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("SearXNG");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.brave.apiKey).toBe("existing");
		expect(saved.provider).toBeUndefined();
		expect(saved.apiKey).toBeUndefined();
	});

	it("keeps existing URL and key when both inputs are empty", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: "http://existing:8080", apiKey: "existing-key" } } } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("SearXNG (configured)");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("").mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.searxng.baseUrl).toBe("http://existing:8080");
		expect(saved.search.sources.searxng.apiKey).toBe("existing-key");
		expect(saved.baseUrls).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
	});

	it("marks searxng (configured) when SEARXNG_URL env is set, but not when only the default applies", async () => {
		// Default URL alone is not "configured" — keep the (configured) marker
		// meaningful so it tells the user they've intentionally set something.
		{
			const { captured } = registerAndCapture();
			const ctx = createMockCtx({ hasUI: true });
			(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
			await captured.commands.get("web-tools")?.handler("", ctx as never);
			const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
			expect(labels).toContain("SearXNG");
			expect(labels).not.toContain("SearXNG (configured)");
		}
		process.env.SEARXNG_URL = "http://my-searx:8080";
		{
			const { captured } = registerAndCapture();
			const ctx = createMockCtx({ hasUI: true });
			(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
			await captured.commands.get("web-tools")?.handler("", ctx as never);
			const labels = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0][1] as string[];
			expect(labels).toContain("SearXNG (configured)");
		}
	});

	it("show surfaces the resolved searxng URL and its source (env)", async () => {
		process.env.SEARXNG_URL = "http://my-searx:8080";
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("searxng url: http://my-searx:8080");
		expect(msg).toContain("source: env");
	});

	it("show surfaces the resolved searxng URL and its source (config)", async () => {
		writeConfig({ search: { sources: { searxng: { baseUrl: "http://config-host:7000" } } } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("searxng url: http://config-host:7000");
		expect(msg).toContain("source: config");
	});

	it("show surfaces the resolved searxng URL and its source (default)", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain(`searxng url: ${SEARXNG_DEFAULT_URL}`);
		expect(msg).toContain("source: default");
	});
});

describe("SEARXNG_PROVIDER_META", () => {
	// The meta drives downstream introspection (which env var activates a
	// provider, which surfaces in `show`, etc.). `envVar` and `baseUrlEnvVar`
	// are distinct concepts and the fix that introduced `baseUrlEnvVar` is
	// only meaningful if both fields are set correctly.
	it("declares envVar as SEARXNG_API_KEY (optional Bearer key)", () => {
		expect(SEARXNG_PROVIDER_META.envVar).toBe("SEARXNG_API_KEY");
	});

	it("declares baseUrlEnvVar as SEARXNG_URL (the URL that actually activates it)", () => {
		expect(SEARXNG_PROVIDER_META.baseUrlEnvVar).toBe("SEARXNG_URL");
	});
});

describe("SearxngProvider constructor", () => {
	// A user-supplied SEARXNG_URL must not be allowed to silently become a
	// non-http(s) scheme. `new URL()` accepts file://, javascript:, data:, etc.,
	// so we reject anything outside http/https up front instead of letting it
	// reach the fetch path.
	it("accepts http baseUrl", () => {
		expect(() => new SearxngProvider({ baseUrl: "http://localhost:8080" })).not.toThrow();
	});

	it("accepts https baseUrl", () => {
		expect(() => new SearxngProvider({ baseUrl: "https://searx.example/" })).not.toThrow();
	});

	it("accepts an empty baseUrl (deferred-config state — search() then throws)", () => {
		expect(() => new SearxngProvider({ baseUrl: "" })).not.toThrow();
	});

	it("rejects file:// scheme", () => {
		expect(() => new SearxngProvider({ baseUrl: "file:///etc/passwd" })).toThrow(/must use http/);
	});

	it("rejects javascript: scheme", () => {
		expect(() => new SearxngProvider({ baseUrl: "javascript:alert(1)" })).toThrow(/must use http/);
	});

	it("rejects an unparseable URL", () => {
		expect(() => new SearxngProvider({ baseUrl: "not a url" })).toThrow(/is not a valid URL/);
	});
});

// The integrated paths (web_search.execute, /web-tools) always supply
// a baseUrl via resolveSearxngBaseUrl, which falls back to SEARXNG_DEFAULT_URL.
// The "is not set" error path inside SearxngProvider.search() is therefore
// only reachable for direct programmatic consumers — the class is exported,
// so it's still part of the public surface. Pin it directly.
describe("SearxngProvider.search() — direct unit tests", () => {
	it("throws 'SEARXNG_URL is not set' when constructed with an empty baseUrl", async () => {
		const provider = new SearxngProvider({ baseUrl: "" });
		await expect(provider.search("q", 5)).rejects.toThrow(/SEARXNG_URL is not set/);
	});
});

// Direct unit tests for the extracted helper — covers the prompt/keep/default
// logic that the /web-tools integration tests above also exercise via
// the caller, but at finer resolution and without needing the full registration.
describe("configureSearxng", () => {
	function makeUi(inputs: Array<string | null | undefined>) {
		const calls: Array<{ label: string; placeholder: string }> = [];
		const ui = {
			async input(label: string, placeholder: string) {
				calls.push({ label, placeholder });
				return inputs.shift();
			},
		};
		return { ui, calls };
	}

	it("returns null when the user cancels at the URL prompt", async () => {
		const { ui } = makeUi([undefined]);
		expect(await configureSearxng(ui, {})).toBeNull();
	});

	it("returns null when the user cancels at the API-key prompt", async () => {
		const { ui } = makeUi(["http://h:8080", undefined]);
		expect(await configureSearxng(ui, {})).toBeNull();
	});

	it("uses SEARXNG_DEFAULT_URL and null apiKey when both inputs are empty and no current values exist", async () => {
		const { ui } = makeUi(["", ""]);
		expect(await configureSearxng(ui, {})).toEqual({ baseUrl: SEARXNG_DEFAULT_URL, apiKey: null });
	});

	it("keeps current values when both inputs are empty", async () => {
		const { ui } = makeUi(["", ""]);
		expect(await configureSearxng(ui, { baseUrl: "http://kept:8080", apiKey: "kept-key" })).toEqual({
			baseUrl: "http://kept:8080",
			apiKey: "kept-key",
		});
	});

	it("uses fresh values when both inputs are non-empty", async () => {
		const { ui } = makeUi(["  http://new:8080  ", "  new-key  "]);
		expect(await configureSearxng(ui, { baseUrl: "http://kept:8080", apiKey: "kept-key" })).toEqual({
			baseUrl: "http://new:8080",
			apiKey: "new-key",
		});
	});

	it("prompts URL first, then key, with placeholders that reflect current values", async () => {
		const { ui, calls } = makeUi(["", ""]);
		await configureSearxng(ui, { baseUrl: "http://existing:8080", apiKey: "existing-key" });
		expect(calls).toHaveLength(2);
		expect(calls[0].label).toMatch(/URL/i);
		expect(calls[0].placeholder).toContain("http://existing:8080");
		expect(calls[1].label).toMatch(/key/i);
		// Mask hides the middle but reveals the first/last 4 chars
		expect(calls[1].placeholder).toContain("exis...-key");
	});
});

// ---------------------------------------------------------------------------
// Ollama provider-specific tests
// ---------------------------------------------------------------------------
// Ollama is structurally similar to SearXNG: self-hosted with configurable
// baseUrl, optional API key, and vendor fetch endpoint. Kept out of
// PROVIDER_MATRIX because the optional key breaks the generic "no key" test.

describe("web_search.execute — ollama", () => {
	const OLLAMA_OK_BODY = JSON.stringify({
		results: [
			{ title: "T1", url: "https://result.example/1", content: "snippet 1" },
			{ title: "T2", url: "https://result.example/2", content: "snippet 2" },
		],
	});

	it("uses env URL (wins over config and default)", async () => {
		process.env.OLLAMA_HOST = "http://env-host:9000";
		writeConfig({ search: { sources: { ollama: { baseUrl: "http://config-host:7000" } } } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://env-host:9000/"),
				response: () => new Response(OLLAMA_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello" }, undefined as never, undefined as never, createMockCtx());
		const callUrl = new URL(stub.calls[0].url);
		expect(`${callUrl.protocol}//${callUrl.host}`).toBe("http://env-host:9000");
		expect(callUrl.pathname).toBe("/api/web_search");
		const body = JSON.parse(stub.calls[0].init?.body as string);
		expect(body.query).toBe("hello");
		expect(body.max_results).toBeDefined();
	});

	it("falls back to config URL when env is unset", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: "http://config-host:7000" } } } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://config-host:7000/"),
				response: () => new Response(OLLAMA_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).host).toBe("config-host:7000");
	});

	it("uses configured default Ollama URL when selected without a custom URL", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		const stub = stubFetch([
			{
				match: (u) => u.startsWith("http://localhost:11434/"),
				response: () => new Response(OLLAMA_OK_BODY, { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(new URL(stub.calls[0].url).host).toBe("localhost:11434");
	});

	it("trailing slash on baseUrl does not produce a double-slash", async () => {
		process.env.OLLAMA_HOST = "http://host:11434/";
		const stub = stubFetch([
			{ match: (u) => u.includes("host:11434"), response: () => new Response(OLLAMA_OK_BODY, { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(stub.calls[0].url).not.toMatch(/\/\/api/);
	});

	it("sends Bearer Authorization when API key is configured", async () => {
		process.env.OLLAMA_API_KEY = "test-key";
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		const stub = stubFetch([{ match: () => true, response: () => new Response(OLLAMA_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer test-key");
	});

	it("omits Authorization when no API key is configured", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		const stub = stubFetch([{ match: () => true, response: () => new Response(OLLAMA_OK_BODY, { status: 200 }) }]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers.Authorization).toBeUndefined();
	});

	it("returns no-results envelope on empty results array", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		stubFetch([
			{ match: () => true, response: () => new Response(JSON.stringify({ results: [] }), { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("No results found") });
	});

	it("wraps non-2xx as 'Ollama Search API error (status)'", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		stubFetch([{ match: () => true, response: () => new Response("oops", { status: 500 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Ollama Search API error \(500\)/);
	});

	it("401 attaches the 'ollama signin' hint", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		stubFetch([{ match: () => true, response: () => new Response("unauthorized", { status: 401 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/ollama signin/);
	});

	it("404 attaches the 'may not support web search' hint", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		stubFetch([{ match: () => true, response: () => new Response("not found", { status: 404 }) }]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/may not support web search/);
	});

	it("normalizes missing fields on result rows to empty strings", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		stubFetch([
			{ match: () => true, response: () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }) },
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const result = (r?.details as { results: Array<{ title: string; url: string; snippet: string }> }).results[0];
		expect(result.title).toBe("");
		expect(result.url).toBe("");
		expect(result.snippet).toBe("");
	});
});

describe("web_fetch.execute — ollama vendor fetch", () => {
	it("ollama fetch uses /api/experimental/web_fetch endpoint", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		stubFetch([
			{
				match: (u) => u.includes("/api/experimental/web_fetch"),
				response: () =>
					new Response(
						JSON.stringify({ title: "Test Page", content: "extracted text", links: ["https://example.com"] }),
						{
							status: 200,
						},
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("extracted text") });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Test Page") });
	});

	it("ollama fetch throws when content is empty", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		stubFetch([
			{
				match: (u) => u.includes("/api/experimental/web_fetch"),
				response: () => new Response(JSON.stringify({ title: "Empty", content: "", links: [] }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/no content returned/);
	});

	it("ollama fetch wraps non-2xx as 'Ollama Fetch API error (status)'", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		stubFetch([
			{
				match: (u) => u.includes("/api/experimental/web_fetch"),
				response: () => new Response("bad", { status: 502 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Ollama Fetch API error \(502\)/);
	});
});

describe("web_search.execute — ollama network errors", () => {
	it("surfaces connection-refused with actionable hint", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: OLLAMA_DEFAULT_URL } } } });
		const connRefusedError = new TypeError("fetch failed");
		(connRefusedError as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
		stubFetch([
			{
				match: () => true,
				response: () => {
					throw connRefusedError;
				},
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/Could not connect to Ollama.*Make sure Ollama is running/);
	});
});

describe("/web-tools command — ollama", () => {
	it("prompts URL first, then optional key, and persists both", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Ollama");
		const inputMock = ctx.ui.input as ReturnType<typeof vi.fn>;
		inputMock.mockResolvedValueOnce("http://my-ollama:11434").mockResolvedValueOnce("my-api-key");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved).toMatchObject({
			search: {
				sources: {
					ollama: { baseUrl: "http://my-ollama:11434", apiKey: "my-api-key" },
				},
			},
		});
		expect(saved.provider).toBeUndefined();
		expect(saved.baseUrls).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
		expect(inputMock.mock.calls).toHaveLength(2);
		expect(String(inputMock.mock.calls[0][0])).toMatch(/URL/i);
		expect(String(inputMock.mock.calls[1][0])).toMatch(/key/i);
	});

	it("empty URL input falls back to the default URL and leaves key unset", async () => {
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Ollama");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("").mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.ollama.baseUrl).toBe("http://localhost:11434");
		expect(saved.search.sources.ollama.apiKey).toBeUndefined();
		expect(saved.provider).toBeUndefined();
		expect(saved.baseUrls).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
	});

	it("URL cancel (undefined) leaves config untouched", async () => {
		writeConfig({ apiKey: "existing" });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Ollama");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.brave.apiKey).toBe("existing");
		expect(saved.provider).toBeUndefined();
		expect(saved.apiKey).toBeUndefined();
	});

	it("keeps existing URL and key when both inputs are empty", async () => {
		writeConfig({ search: { sources: { ollama: { baseUrl: "http://existing:11434", apiKey: "existing-key" } } } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockResolvedValueOnce("Ollama (configured)");
		(ctx.ui.input as ReturnType<typeof vi.fn>).mockResolvedValueOnce("").mockResolvedValueOnce("");
		await captured.commands.get("web-tools")?.handler("", ctx as never);
		const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		expect(saved.search.sources.ollama.baseUrl).toBe("http://existing:11434");
		expect(saved.search.sources.ollama.apiKey).toBe("existing-key");
		expect(saved.baseUrls).toBeUndefined();
		expect(saved.apiKeys).toBeUndefined();
	});
});

describe("web_search.execute — jina", () => {
	it("parses the current Jina search data array shape", async () => {
		process.env.JINA_API_KEY = "k";
		writeConfig({ search: { sources: { jina: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("s.jina.ai"),
				response: () =>
					new Response(JSON.stringify({ code: 200, status: 200, data: [{ title: "Jina", url: "https://jina.example", description: "hit" }] }), {
						status: 200,
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { sourceResultCounts: Record<string, number> }).sourceResultCounts).toEqual({ jina: 1 });
	});

	it("still parses the legacy Jina search data.results envelope", async () => {
		process.env.JINA_API_KEY = "k";
		writeConfig({ search: { sources: { jina: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("s.jina.ai"),
				response: () =>
					new Response(
						JSON.stringify({ code: 200, status: 200, data: { results: [{ title: "Jina", url: "https://jina.example", description: "hit" }] } }),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello" }, undefined as never, undefined as never, createMockCtx());
		expect((r?.details as { sourceResultCounts: Record<string, number> }).sourceResultCounts).toEqual({ jina: 1 });
	});
});

// You.com has a dedicated test block (like SearXNG/Ollama) for fine-grained assertions.
describe("web_search.execute — youcom", () => {
	it("uses env key", async () => {
		process.env.YOUCOM_API_KEY = "env-key";
		writeConfig({ search: { sources: { youcom: {} } } });
		const stub = stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () =>
					new Response(
						JSON.stringify({
							results: { web: [{ title: "T", url: "https://x", description: "snip", snippets: ["snip"] }] },
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "hello", max_results: 3 }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers["X-API-Key"]).toBe("env-key");
	});

	it("falls back to config key", async () => {
		writeConfig({ search: { sources: { youcom: { apiKey: "config-key" } } } });
		const stub = stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () =>
					new Response(
						JSON.stringify({
							results: { web: [{ title: "T", url: "https://x", description: "snip", snippets: ["snip"] }] },
						}),
						{ status: 200 },
					),
			},
		]);
		const { captured } = registerAndCapture();
		await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		const headers = stub.calls[0].init?.headers as Record<string, string>;
		expect(headers["X-API-Key"]).toBe("config-key");
	});

	it("throws when no key configured", async () => {
		writeConfig({ search: { sources: { youcom: {} } } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/YOUCOM_API_KEY is not set/);
	});

	it("returns no-results envelope on empty results", async () => {
		process.env.YOUCOM_API_KEY = "k";
		writeConfig({ search: { sources: { youcom: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () => new Response(JSON.stringify({ results: {} }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("No results found") });
	});

	it("wraps non-2xx as 'You.com Search API error (status)'", async () => {
		process.env.YOUCOM_API_KEY = "k";
		writeConfig({ search: { sources: { youcom: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () => new Response("rate limit", { status: 429 }),
			},
		]);
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_search")
				?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx()),
		).rejects.toThrow(/You\.com Search API error \(429\)/);
	});

	it("tolerates missing fields in results", async () => {
		process.env.YOUCOM_API_KEY = "k";
		writeConfig({ search: { sources: { youcom: {} } } });
		stubFetch([
			{
				match: (u) => u.includes("ydc-index.io/v1/search"),
				response: () => new Response(JSON.stringify({ results: { web: [{}] } }), { status: 200 }),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_search")
			?.execute?.("tc", { query: "x" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.details).toMatchObject({ results: [{ title: "", url: "", snippet: "" }] });
	});
});

describe("web_fetch.execute — github intercept", () => {
	it("default ON: github.com code URLs hit the GitHub interceptor", async () => {
		const interceptSpy = vi
			.spyOn(GitHubInterceptor.prototype, "intercept")
			.mockResolvedValue({ text: "cloned by default", title: "owner/repo", contentType: "text/plain" });
		try {
			const { captured } = registerAndCapture();
			const r = await captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "https://github.com/owner/repo/blob/main/file.ts" },
					undefined as never,
					undefined as never,
					createMockCtx(),
				);
			expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("cloned by default") });
			expect(interceptSpy).toHaveBeenCalledWith(
				"https://github.com/owner/repo/blob/main/file.ts",
				expect.objectContaining({ raw: false, forceClone: false }),
			);
		} finally {
			interceptSpy.mockRestore();
		}
	});

	it("user config wins: { interceptors: { github: false } } overrides consumer default", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } }, interceptors: { github: false } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>plain github page</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi, { interceptors: { github: true } });
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/blob/main/file.ts" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("plain github page") });
	});

	it("passes forceClone through to the GitHub interceptor", async () => {
		writeConfig({ interceptors: { github: true } });
		const interceptSpy = vi
			.spyOn(GitHubInterceptor.prototype, "intercept")
			.mockResolvedValue({ text: "cloned", title: "owner/repo", contentType: "text/plain" });
		try {
			const { captured } = registerAndCapture();
			const r = await captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "https://github.com/owner/repo", forceClone: true },
					undefined as never,
					undefined as never,
					createMockCtx(),
				);
			expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("cloned") });
			expect(interceptSpy).toHaveBeenCalledWith(
				"https://github.com/owner/repo",
				expect.objectContaining({ raw: false, forceClone: true }),
			);
		} finally {
			interceptSpy.mockRestore();
		}
	});

	it("falls back to generic fetch when parseGitHubUrl returns null (non-code github URL)", async () => {
		// Even with the interceptor enabled, github.com/owner/repo/issues lands
		// in NON_CODE_SEGMENTS, so intercept() returns null and the chain falls
		// through to the configured source's fetch.
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } }, interceptors: { github: true } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>GitHub Issues page</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/issues" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ type: "text" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("GitHub Issues page") });
	});

	it("does not intercept non-GitHub URLs — configured source handles them", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } }, interceptors: { github: true } });
		stubFetch([
			{
				match: (u) => u.includes("example.com"),
				response: () =>
					new Response("<html><body>Not GitHub</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { captured } = registerAndCapture();
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com" }, undefined as never, undefined as never, createMockCtx());
		expect(r?.content[0]).toMatchObject({ type: "text" });
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("Not GitHub") });
	});

	it("SSRF guard fires before github.com hostname check — refuses private/loopback addresses", async () => {
		// Confirms parseAndAssertHttpUrl() runs first; private IPs cannot sneak
		// through by having a github.com-shaped path segment.
		writeConfig({ interceptors: { github: true } });
		const { captured } = registerAndCapture();
		await expect(
			captured.tools
				.get("web_fetch")
				?.execute?.(
					"tc",
					{ url: "http://192.168.1.1/owner/repo/blob/main/file.ts" },
					undefined as never,
					undefined as never,
					createMockCtx(),
				),
		).rejects.toThrow(/private|loopback/i);
	});
});

describe("formatShowConfigMessage — URL interceptors block", () => {
	it("show lists 'github: disabled' with restore-default hint when explicitly off", async () => {
		writeConfig({ interceptors: { github: false } });
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("URL interceptors:");
		expect(msg).toContain("github: disabled");
		expect(msg).toContain("restore default");
		expect(msg).toContain('"github": false');
	});

	it("show lists 'github: enabled' with token + clonePath by default", async () => {
		process.env.GITHUB_TOKEN = "ghp_abcdefgh1234";
		const { captured } = registerAndCapture();
		const ctx = createMockCtx({ hasUI: true });
		await captured.commands.get("web-tools")?.handler("show", ctx as never);
		const msg = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(msg).toContain("URL interceptors:");
		expect(msg).toContain("github: enabled");
		expect(msg).toContain("GITHUB_TOKEN: ghp_");
		expect(msg).toContain("clonePath:");
		expect(msg).toContain("cloneTtlHours: 24");
	});
});
