/**
 * PDF extraction via system `pdftotext` (poppler). No new npm dependency.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";

export interface PDFExtractResult {
	title: string;
	pages?: number;
	chars: number;
	outputPath: string;
	content: string;
}

export interface PDFExtractOptions {
	outputDir?: string;
	filename?: string;
}

const DEFAULT_OUTPUT_DIR = join(homedir(), "Downloads");

export function isPDF(url: string, contentType?: string): boolean {
	if (contentType?.includes("application/pdf")) return true;
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

function extractTitleFromURL(url: string): string {
	try {
		const urlObj = new URL(url);
		let filename = basename(urlObj.pathname, ".pdf");
		if (urlObj.hostname.includes("arxiv.org")) {
			const match = urlObj.pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/);
			if (match) filename = `arxiv-${match[1]}`;
		}
		return (
			filename
				.replace(/[_-]+/g, " ")
				.replace(/\s+/g, " ")
				.trim() || "document"
		);
	} catch {
		return "document";
	}
}

function sanitizeFilename(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.slice(0, 100)
			.replace(/^-|-$/g, "") || "document"
	);
}

async function pdftotext(buffer: Buffer): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("pdftotext", ["-layout", "-", "-"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (c) => chunks.push(c));
		child.stderr.on("data", (c) => errChunks.push(c));
		child.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				reject(new Error("pdftotext not found. Install poppler-utils to extract PDF text."));
			} else {
				reject(err);
			}
		});
		child.on("close", (code) => {
			if (code !== 0) {
				const err = Buffer.concat(errChunks).toString("utf8").trim();
				reject(new Error(err || `pdftotext exited with code ${code}`));
				return;
			}
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		child.stdin.write(buffer);
		child.stdin.end();
	});
}

export async function extractPDFToMarkdown(
	buffer: ArrayBuffer | Buffer,
	url: string,
	options: PDFExtractOptions = {},
): Promise<PDFExtractResult> {
	const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
	const title = extractTitleFromURL(url);
	const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	const text = (await pdftotext(raw)).trim();
	if (!text) throw new Error("PDF text extraction returned empty content");

	const content = [`# ${title}`, "", `> Source: ${url}`, "", "---", "", text].join("\n");
	const outputFilename = options.filename || `${sanitizeFilename(title)}.md`;
	const outputPath = join(outputDir, outputFilename);
	await mkdir(outputDir, { recursive: true });
	await writeFile(outputPath, content, "utf-8");
	return { title, chars: content.length, outputPath, content };
}
