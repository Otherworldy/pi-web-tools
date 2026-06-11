/**
 * Tests the interceptor chain dispatch in registerWebTools: first-match-wins,
 * empty-chain fall-through, and the consumer×user-config default-on resolution.
 * Exercises the chain end-to-end via the registered web_fetch tool rather
 * than the GitHubInterceptor class directly.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createMockCtx, createMockPi, stubFetch } from "@juicesharp/rpiv-test-utils";
import { beforeEach, describe, expect, it } from "vitest";
import registerWebTools from "../../index.js";
import { configPath } from "../config.js";

const CONFIG_PATH = configPath("rpiv-web-tools");

function writeConfig(contents: unknown) {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(contents), "utf-8");
}

beforeEach(() => {
	delete process.env.BRAVE_SEARCH_API_KEY;
	delete process.env.GITHUB_TOKEN;
	rmSync(CONFIG_PATH, { force: true });
});

describe("interceptor chain — default-on resolution", () => {
	it("default ON: non-code github URL still falls through to generic fetch", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>plain page</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi);
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/issues" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("plain page") });
	});

	it("consumer:false disables the interceptor when user config is absent", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>generic fallback</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi, { interceptors: { github: false } });
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/blob/main/file.ts" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("generic fallback") });
	});

	it("user config false beats consumer true (explicit user disable)", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } }, interceptors: { github: false } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>generic only</body></html>", {
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
				{ url: "https://github.com/owner/repo/blob/main/x.ts" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		// Interceptor is off — generic fetch handled it.
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("generic only") });
	});

	it("user object form keeps the interceptor enabled even when consumer disables it", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } }, interceptors: { github: { maxRepoSizeMB: 999 } } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>generic fallback</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi, { interceptors: { github: false } });
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/issues" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("generic fallback") });
	});
});

describe("interceptor chain — fall-through semantics", () => {
	it("interceptor returning null falls through to generic fetch fallback", async () => {
		// owner/repo/issues → NON_CODE_SEGMENTS → parseGitHubUrl returns null,
		// intercept short-circuits to null → generic fetch handles the URL.
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } }, interceptors: { github: true } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>fallback body</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi);
		const r = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/issues" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r?.content[0]).toMatchObject({ text: expect.stringContaining("fallback body") });
	});

	it("empty chain (interceptor disabled) is a no-op — every URL hits generic fetch", async () => {
		process.env.BRAVE_SEARCH_API_KEY = "k";
		writeConfig({ search: { sources: { brave: {} } }, interceptors: { github: false } });
		stubFetch([
			{
				match: () => true,
				response: () =>
					new Response("<html><body>vanilla</body></html>", {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			},
		]);
		const { pi, captured } = createMockPi();
		registerWebTools(pi);
		const r1 = await captured.tools
			.get("web_fetch")
			?.execute?.("tc", { url: "https://example.com/" }, undefined as never, undefined as never, createMockCtx());
		const r2 = await captured.tools
			.get("web_fetch")
			?.execute?.(
				"tc",
				{ url: "https://github.com/owner/repo/blob/main/file.ts" },
				undefined as never,
				undefined as never,
				createMockCtx(),
			);
		expect(r1?.content[0]).toMatchObject({ text: expect.stringContaining("vanilla") });
		expect(r2?.content[0]).toMatchObject({ text: expect.stringContaining("vanilla") });
	});
});
