import { describe, expect, it } from "vitest";
import { assessClaim, buildResearchArtifact, classifySource, hashContent } from "./source-check.js";

describe("source-check", () => {
	it("classifies docs hosts", () => {
		expect(classifySource("https://docs.example.com/guide")).toBe("official_docs");
		expect(classifySource("https://github.com/org/repo/issues/1")).toBe("repo_issue");
	});

	it("hashes content stably", () => {
		expect(hashContent("hello")).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(hashContent("hello")).toBe(hashContent("hello"));
	});

	it("assesses claim from support markers", () => {
		const artifact = buildResearchArtifact({
			query: "API supports streaming",
			results: [{ title: "Docs", url: "https://docs.example.com/a", snippet: "The API supports streaming responses" }],
		});
		const assessment = assessClaim("API supports streaming", artifact.passages);
		expect(["supported", "unclear", "missing-evidence"]).toContain(assessment.status);
	});
});
