import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeCompactionResult } from "../src/core/compaction/checkpoint.ts";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import type { SessionEntry } from "../src/core/session-manager.ts";

const directories: string[] = [];
const branch = (text = "recent"): SessionEntry[] => [
	{
		type: "message",
		id: "kept",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: text, timestamp: 0 },
	},
];
const result = (summary: string) => ({
	summary,
	firstKeptEntryId: "kept",
	tokensBefore: 9000,
	details: { readFiles: ["a.ts"] },
});
function sessionFile() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-"));
	directories.push(directory);
	return path.join(directory, "session.jsonl");
}
afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("final checkpoint budget", () => {
	it("allows fitting checkpoints with zero output reserve but still rejects oversized retained context", () => {
		const original = result("Small checkpoint");
		expect(finalizeCompactionResult(original, { branchEntries: branch(), contextWindow: 1000, reserveTokens: 0 })).toBe(
			original,
		);
		expect(() =>
			finalizeCompactionResult(original, {
				branchEntries: branch("x".repeat(8000)),
				contextWindow: 1000,
				reserveTokens: 0,
			}),
		).toThrow(/retained context/);
	});
	it("archives the entire assembled checkpoint including oversized file metadata", () => {
		const summary = `Summary\n<read-files>\n${Array.from({ length: 1000 }, (_, i) => `packages/example/folder-${i}/component.ts`).join("\n")}\n</read-files>\n## Recovery\nFull recovery instructions`;
		const finalized = finalizeCompactionResult(result(summary), {
			branchEntries: branch(),
			contextWindow: 8000,
			reserveTokens: 1000,
			sessionFile: sessionFile(),
		});
		expect(finalized.summary.length).toBeLessThan(1000);
		const details = finalized.details as { readFiles: string[]; checkpointArchive: { path: string; summary: string } };
		expect(details.readFiles).toEqual(["a.ts"]);
		expect(details.checkpointArchive.summary).toBe(summary);
		expect(fs.readFileSync(details.checkpointArchive.path, "utf8")).toBe(summary);
		expect(finalized.summary).toContain(details.checkpointArchive.path);
	});
	it("counts retained messages and refuses when even a pointer cannot fit", () => {
		const entries = branch("x".repeat(40_000));
		expect(() =>
			finalizeCompactionResult(result("Summary"), {
				branchEntries: entries,
				contextWindow: 8000,
				reserveTokens: 1000,
				sessionFile: sessionFile(),
			}),
		).toThrow(/retained context/);
		expect(entries).toHaveLength(1);
	});
	it("does not replace context when durable storage fails", () => {
		const blocker = sessionFile();
		fs.writeFileSync(blocker, "not a directory");
		expect(() =>
			finalizeCompactionResult(result("x".repeat(40_000)), {
				branchEntries: branch(),
				contextWindow: 8000,
				reserveTokens: 1000,
				sessionFile: path.join(blocker, "session.jsonl"),
			}),
		).toThrow(/persist/);
	});
	it("keeps an oversized checkpoint inline, cut with a marker, when the session has no file at all", () => {
		const summary = `Head of the summary ${"x".repeat(40_000)} tail of the summary`;
		const finalized = finalizeCompactionResult(result(summary), {
			branchEntries: branch(),
			contextWindow: 8000,
			reserveTokens: 1000,
		});
		expect(finalized.summary.startsWith("Head of the summary")).toBe(true);
		expect(finalized.summary.endsWith("tail of the summary")).toBe(true);
		expect(finalized.summary).toContain("characters omitted");
		expect(Math.ceil(finalized.summary.length / CHARS_PER_TOKEN)).toBeLessThanOrEqual(800);
		expect(finalized.details).toEqual({ readFiles: ["a.ts"] });
	});
	it("keeps a fitting checkpoint unchanged", () => {
		const original = result("Small checkpoint");
		expect(
			finalizeCompactionResult(original, { branchEntries: branch(), contextWindow: 8000, reserveTokens: 1000 }),
		).toBe(original);
	});
	it("counts the current system prompt", () => {
		const entries = branch();
		entries.unshift({
			type: "message",
			id: "system",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "system", content: "x".repeat(40_000), timestamp: 0 },
		});
		entries[1].parentId = "system";
		expect(() =>
			finalizeCompactionResult(result("Summary"), {
				branchEntries: entries,
				contextWindow: 8000,
				reserveTokens: 1000,
				sessionFile: sessionFile(),
			}),
		).toThrow(/retained context/);
	});
	it("counts active tool declarations in the retained system snapshot", () => {
		const entries = branch();
		entries.unshift({
			type: "message",
			id: "system",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				role: "system",
				content: "",
				timestamp: 0,
				toolsAdded: [
					{ name: "large", description: "x".repeat(40_000), parameters: { type: "object", properties: {} } },
				],
			},
		});
		entries[1].parentId = "system";
		expect(() =>
			finalizeCompactionResult(result("Summary"), {
				branchEntries: entries,
				contextWindow: 8000,
				reserveTokens: 1000,
				sessionFile: sessionFile(),
			}),
		).toThrow(/retained context/);
	});
	it("carries the previous complete checkpoint reference into the next checkpoint", () => {
		const file = sessionFile();
		const first = finalizeCompactionResult(result("x".repeat(40_000)), {
			branchEntries: branch(),
			contextWindow: 8000,
			reserveTokens: 1000,
			sessionFile: file,
		});
		const archive = (first.details as { checkpointArchive: { path: string } }).checkpointArchive;
		const entries = branch();
		entries.push({
			type: "compaction",
			id: "previous",
			parentId: "kept",
			timestamp: new Date().toISOString(),
			summary: first.summary,
			firstKeptEntryId: "kept",
			tokensBefore: 9000,
			details: first.details,
		});
		const next = finalizeCompactionResult(result("Next summary"), {
			branchEntries: entries,
			contextWindow: 8000,
			reserveTokens: 1000,
			sessionFile: file,
		});
		expect(next.summary).toContain(archive.path);
		expect(fs.readFileSync(archive.path, "utf8")).toBe("x".repeat(40_000));
	});
});
