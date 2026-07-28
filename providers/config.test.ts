import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, getConfigPath, getLegacyConfigPath, readConfig, WebToolsConfigSchema, writeConfig } from "./config.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "pi-web-tools-config-"));
const CONFIG_PATH = join(TEST_DIR, "config.json");
const LEGACY_CONFIG_PATH = join(homedir(), ".config", "pi-web-tools", "config.json");

beforeEach(() => {
	process.env.PI_WEB_TOOLS_CONFIG_PATH = CONFIG_PATH;
	rmSync(CONFIG_PATH, { force: true });
});

afterEach(() => {
	delete process.env.PI_WEB_TOOLS_CONFIG_PATH;
});

function writeRaw(contents: string): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, contents, "utf-8");
}

describe("getConfigPath", () => {
	it("honors PI_WEB_TOOLS_CONFIG_PATH override", () => {
		expect(getConfigPath()).toBe(CONFIG_PATH);
	});

	it("default extension path includes pi-web-tools", () => {
		delete process.env.PI_WEB_TOOLS_CONFIG_PATH;
		expect(configPath("pi-web-tools")).toContain("/extensions/pi-web-tools/config.json");
		process.env.PI_WEB_TOOLS_CONFIG_PATH = CONFIG_PATH;
	});

	it("exposes the legacy ~/.config path for migration compatibility", () => {
		expect(getLegacyConfigPath()).toBe(LEGACY_CONFIG_PATH);
	});
});

describe("readConfig — fail-soft posture", () => {
	it("returns {} when the file does not exist", () => {
		expect(readConfig()).toEqual({});
	});

	it("returns {} on malformed JSON (matches loadJsonConfig tolerance)", () => {
		writeRaw("{ not valid json");
		expect(readConfig()).toEqual({});
	});

	it("returns {} when the file is a directory (EISDIR)", () => {
		mkdirSync(CONFIG_PATH, { recursive: true });
		try {
			expect(readConfig()).toEqual({});
		} finally {
			rmSync(CONFIG_PATH, { recursive: true, force: true });
		}
	});

	it("returns {} when the schema validation fails hard (e.g. provider is a number)", () => {
		writeRaw(JSON.stringify({ provider: 123 }));
		expect(readConfig()).toEqual({});
	});
});

describe("readConfig — released-shape compatibility", () => {
	it("migrates legacy { provider, apiKeys } into search.sources", () => {
		writeRaw(JSON.stringify({ provider: "brave", apiKeys: { brave: "k" } }));
		expect(readConfig()).toEqual({ search: { sources: { brave: { apiKey: "k" } } } });
	});

	it("migrates the legacy top-level apiKey field into brave search source", () => {
		writeRaw(JSON.stringify({ apiKey: "legacy" }));
		expect(readConfig()).toEqual({ search: { sources: { brave: { apiKey: "legacy" } } } });
	});

	it("preserves unknown top-level keys while migrating legacy key fields", () => {
		writeRaw(JSON.stringify({ apiKey: "k", otherField: "keep" }));
		const cfg = readConfig() as { otherField?: string };
		expect(cfg.otherField).toBe("keep");
		expect(cfg.search?.sources?.brave?.apiKey).toBe("k");
		expect(cfg.apiKey).toBeUndefined();
	});

	it("loads per-source enabled flags and result limits", () => {
		writeRaw(
			JSON.stringify({
				search: { defaultResults: 10, mergedResults: 25, sources: { exa: { enabled: false, resultLimit: 15 } } },
			}),
		);
		expect(readConfig()).toEqual({
			search: { defaultResults: 10, mergedResults: 25, sources: { exa: { enabled: false, resultLimit: 15 } } },
		});
	});

	it("loads the guidance subtree with web_search + web_fetch", () => {
		writeRaw(
			JSON.stringify({
				guidance: {
					web_search: { promptSnippet: "snip", promptGuidelines: ["a", "b"] },
					web_fetch: { promptSnippet: "snip2" },
				},
			}),
		);
		const cfg = readConfig();
		expect(cfg.guidance?.web_search?.promptSnippet).toBe("snip");
		expect(cfg.guidance?.web_fetch?.promptSnippet).toBe("snip2");
	});

	it("migrates defaultSearchResults into search.defaultResults", () => {
		writeRaw(JSON.stringify({ defaultSearchResults: 8 }));
		expect(readConfig().search?.defaultResults).toBe(8);
	});

	it("skips legacy path migration when PI_WEB_TOOLS_CONFIG_PATH is set", () => {
		mkdirSync(dirname(LEGACY_CONFIG_PATH), { recursive: true });
		writeFileSync(LEGACY_CONFIG_PATH, '{"provider":"brave","apiKeys":{"brave":"legacy"}}', "utf-8");
		try {
			expect(readConfig()).toEqual({});
		} finally {
			rmSync(LEGACY_CONFIG_PATH, { force: true });
		}
	});
});

describe("readConfig — interceptors.github union", () => {
	it("accepts the boolean true shorthand", () => {
		writeRaw(JSON.stringify({ interceptors: { github: true } }));
		expect(readConfig().interceptors?.github).toBe(true);
	});

	it("accepts the boolean false shorthand", () => {
		writeRaw(JSON.stringify({ interceptors: { github: false } }));
		expect(readConfig().interceptors?.github).toBe(false);
	});

	it("accepts the object override form", () => {
		writeRaw(
			JSON.stringify({
				interceptors: { github: { maxRepoSizeMB: 1000, clonePath: "/x", cloneTtlHours: 48 } },
			}),
		);
		const gh = readConfig().interceptors?.github;
		expect(gh).toEqual({ maxRepoSizeMB: 1000, clonePath: "/x", cloneTtlHours: 48 });
	});

	it("falls back to {} when interceptors.github has a type-incompatible shape", () => {
		// A number is neither boolean nor a GitHubInterceptorOptions object —
		// hard schema failure → fail-soft to {}.
		writeRaw(JSON.stringify({ interceptors: { github: 42 } }));
		expect(readConfig()).toEqual({});
	});
});

describe("writeConfig", () => {
	it("round-trips a config through readConfig", () => {
		expect(writeConfig({ provider: "brave", apiKeys: { brave: "k" }, defaultSearchResults: 7 })).toBe(true);
		expect(readConfig()).toEqual({ search: { defaultResults: 7, sources: { brave: { apiKey: "k" } } } });
	});

	it("round-trips canonical source flags and result limits", () => {
		expect(
			writeConfig({
				search: { defaultResults: 10, mergedResults: 30, sources: { brave: { enabled: false, apiKey: "k", resultLimit: 12 } } },
			}),
		).toBe(true);
		expect(readConfig()).toEqual({
			search: { defaultResults: 10, mergedResults: 30, sources: { brave: { enabled: false, apiKey: "k", resultLimit: 12 } } },
		});
	});

	it("preserves the interceptors.github stanza across save+load", () => {
		expect(writeConfig({ interceptors: { github: { maxRepoSizeMB: 500 } } })).toBe(true);
		expect(readConfig().interceptors?.github).toEqual({ maxRepoSizeMB: 500 });
	});
});

describe("WebToolsConfigSchema — schema-only sanity", () => {
	it("exists and is a JSON-schema-compatible object", () => {
		expect(WebToolsConfigSchema).toBeDefined();
		expect(WebToolsConfigSchema.type).toBe("object");
	});
});
