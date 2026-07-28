import { describe, expect, it } from "vitest";
import { parseAllowRanges, validateRemoteUrl } from "./ssrf.js";

describe("ssrf", () => {
	it("blocks private IPv4 literals", async () => {
		await expect(validateRemoteUrl("http://127.0.0.1/")).rejects.toThrow(/Blocked/);
		await expect(validateRemoteUrl("http://192.168.1.1/")).rejects.toThrow(/Blocked/);
		await expect(validateRemoteUrl("http://10.0.0.5/")).rejects.toThrow(/Blocked/);
	});

	it("blocks localhost hostname", async () => {
		await expect(validateRemoteUrl("http://localhost/")).rejects.toThrow(/Blocked/);
	});

	it("allows public IPv4 literal", async () => {
		const url = await validateRemoteUrl("https://1.1.1.1/");
		expect(url.hostname).toBe("1.1.1.1");
	});

	it("honors allowRanges for fake-IP space", async () => {
		const url = await validateRemoteUrl("http://198.18.0.1/", {
			allowRanges: ["198.18.0.0/15"],
		});
		expect(url.hostname).toBe("198.18.0.1");
	});

	it("rejects invalid allowRanges", () => {
		expect(() => parseAllowRanges(["not-a-cidr"])).toThrow(/Invalid CIDR/);
	});

	it("enforces domainPolicy deny", async () => {
		await expect(
			validateRemoteUrl("https://evil.example.com/", {
				domainPolicy: { allow: [], deny: ["example.com"] },
				lookup: async () => [{ address: "1.1.1.1", family: 4 }],
			}),
		).rejects.toThrow(/domain policy/);
	});

	it("enforces domainPolicy allow", async () => {
		await expect(
			validateRemoteUrl("https://other.com/", {
				domainPolicy: { allow: ["example.com"], deny: [] },
				lookup: async () => [{ address: "1.1.1.1", family: 4 }],
			}),
		).rejects.toThrow(/not allowed/);
		const ok = await validateRemoteUrl("https://docs.example.com/", {
			domainPolicy: { allow: ["example.com"], deny: [] },
			lookup: async () => [{ address: "1.1.1.1", family: 4 }],
		});
		expect(ok.hostname).toBe("docs.example.com");
	});

	it("blocks DNS results that resolve to private IPs", async () => {
		await expect(
			validateRemoteUrl("https://evil.public.example/", {
				lookup: async () => [{ address: "10.0.0.8", family: 4 }],
			}),
		).rejects.toThrow(/Blocked internal address/);
	});
});
