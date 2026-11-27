import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeCompactionResult, spillFileLists } from "../src/core/compaction/checkpoint.ts";
import { RECOVERY_HEADING, splitSummary, USER_HEADING, viewSummary } from "../src/core/compaction/summary-view.ts";
import { CHARS_PER_TOKEN, charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";
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

const heavy = (kept: string[]) =>
	[
		"## Goal\nShip the parser",
		"## Progress\n" + "- long entry of finished work\n".repeat(4000),
		"## TL;DR\nRewrote the parser.\nTopics: parser",
		`${USER_HEADING}\nEarlier user messages not kept here: 2 (segment 1 has them).\n${kept.map((text) => `<user-message>\n${text}\n</user-message>`).join("\n")}`,
		`${RECOVERY_HEADING}\n- the full transcript before this summary is /t/s.jsonl (JSONL, one entry per line): search it.`,
	].join("\n\n");

describe("what stays inline when a checkpoint is archived", () => {
	it("keeps the goal, the TL;DR, the newest user messages and Recovery, and references the rest", () => {
		const summary = heavy(["older request", "newest request"]);
		const finalized = finalizeCompactionResult(result(summary), {
			branchEntries: branch(),
			contextWindow: 8000,
			reserveTokens: 1000,
			sessionFile: sessionFile(),
		});
		const details = finalized.details as { checkpointArchive: { path: string; summary: string } };
		expect(fs.readFileSync(details.checkpointArchive.path, "utf8")).toBe(summary);
		expect(finalized.summary).toContain(
			`The complete context checkpoint is saved at ${details.checkpointArchive.path}`,
		);
		expect(finalized.summary).toContain("## Goal\nShip the parser");
		expect(finalized.summary).toContain("## TL;DR\nRewrote the parser.");
		expect(finalized.summary).toContain("<user-message>\nnewest request\n</user-message>");
		expect(finalized.summary).toContain(`${RECOVERY_HEADING}\n- the full transcript`);
		expect(finalized.summary).not.toContain("long entry of finished work");
		const view = viewSummary(finalized.summary);
		expect(view.checkpointFile).toBe(details.checkpointArchive.path);
		expect(view.transcript).toBe("/t/s.jsonl");
		expect(view.messages).toContain("newest request");
		expect(splitSummary(finalized.summary).messages.at(-1)).toBe("newest request");
	});

	it("counts every user message it leaves out, even when none fits inline", () => {
		const summary = heavy(["x".repeat(40_000)]);
		const finalized = finalizeCompactionResult(result(summary), {
			branchEntries: branch(),
			contextWindow: 8000,
			reserveTokens: 1000,
			sessionFile: sessionFile(),
		});
		expect(finalized.summary).not.toContain("<user-message>");
		expect(finalized.summary).toContain(
			`${USER_HEADING}\nEarlier user messages not kept here: 3 (the checkpoint file has them).`,
		);
		expect(splitSummary(finalized.summary).omitted).toBe(3);
	});

	it("keeps the standing constraints and key decisions inline, so the ledger survives an archived checkpoint", () => {
		const ledger = [
			"## Constraints & Preferences\n- [C1] Never push to main\n- [C2] Run the parser tests before each commit",
			"## Key Decisions\n- [D1] Keep the hand-written lexer",
		].join("\n\n");
		const summary = heavy(["newest request"]).replace("## TL;DR", `${ledger}\n\n## TL;DR`);
		const finalized = finalizeCompactionResult(result(summary), {
			branchEntries: branch(),
			contextWindow: 8000,
			reserveTokens: 1000,
			sessionFile: sessionFile(),
		});
		expect(finalized.summary).not.toContain("long entry of finished work");
		expect(finalized.summary).toContain("- [C1] Never push to main\n- [C2] Run the parser tests before each commit");
		expect(finalized.summary).toContain("## Key Decisions\n- [D1] Keep the hand-written lexer");
		expect(splitSummary(finalized.summary).messages.at(-1)).toBe("newest request");
	});

	it("keeps what fits, newest messages first, when the window is small", () => {
		const big = "x".repeat(2000);
		const finalized = finalizeCompactionResult(result(heavy([big, "newest request"])), {
			branchEntries: branch(),
			contextWindow: 1000,
			reserveTokens: 500,
			sessionFile: sessionFile(),
		});
		expect(charsToTokens(finalized.summary.length)).toBeLessThanOrEqual(400);
		expect(finalized.summary).toContain("newest request");
		expect(finalized.summary).not.toContain(big);
	});
});

describe("file lists in a checkpoint", () => {
	const paths = Array.from({ length: 500 }, (_, i) => `packages/example/folder-${i}/component.ts`);
	const withLists = `## Goal\nShip it\n\n<read-files>\nshort.ts\n</read-files>\n\n<modified-files>\n${paths.join("\n")}\n</modified-files>`;

	it("moves an over-long list to a file instead of archiving the whole checkpoint", () => {
		const file = sessionFile();
		const finalized = finalizeCompactionResult(result(withLists), {
			branchEntries: branch(),
			contextWindow: 200_000,
			reserveTokens: 16_384,
			sessionFile: file,
		});
		expect(finalized.details).not.toHaveProperty("checkpointArchive");
		expect(finalized.summary).toContain("## Goal\nShip it");
		expect(finalized.summary).toContain("<read-files>\nshort.ts\n</read-files>");
		const spilled = /500 files, listed one per line in (\S+);/.exec(finalized.summary)?.[1];
		expect(spilled?.startsWith(`${file}.checkpoint-`)).toBe(true);
		expect(fs.readFileSync(spilled!, "utf8")).toBe(`${paths.join("\n")}\n`);
		expect(finalized.summary).not.toContain(paths[1]);
		expect(splitSummary(finalized.summary).body).toBe("## Goal\nShip it");
	});

	it("keeps the list whole when it cannot be saved", () => {
		expect(
			spillFileLists(withLists, () => {
				throw new Error("disk full");
			}),
		).toBe(withLists);
		expect(spillFileLists(withLists, () => undefined)).toBe(withLists);
	});
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
