import { getFileStamp } from "@octocodeai/octocode-common/paths";
import { sessions, transcripts } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { writeSessionRecord } from "../../src/octocode/history/archive/record.ts";
import { errorSignature } from "../../src/octocode/history/errors.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const why = { reason: "the user asked which tool errors keep happening" };

let saved: string | undefined;
beforeEach(() => {
	saved = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_HOME = tmp();
	setCurrentSession("me");
});
afterEach(() => {
	setCurrentSession(undefined);
	if (saved === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved;
});

let entry = 0;
const result = (toolName: string, text: string, isError: boolean) => ({
	type: "message",
	id: `e${entry++}`,
	timestamp: "2026-10-25T10:00:00.000Z",
	message: { role: "toolResult", toolCallId: `toolu_${entry}`, toolName, content: [{ type: "text", text }], isError },
});

/** A repository whose one session's transcript holds `entries`; returns a caller of the archive tool in it. */
function archiveOver(entries: unknown[]) {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const transcript = path.join(process.env.OCTOCODE_HOME!, "sessions", "a.jsonl");
	fs.mkdirSync(path.dirname(transcript), { recursive: true });
	fs.writeFileSync(transcript, entries.map((line) => JSON.stringify(line)).join("\n") + "\n");
	const id = "a";
	const workspaceId = registeredWorkspace(cwd).id;
	const db = sharedAgentDb();
	sessions.bind(db.db, id, workspaceId);
	db.mirror.transaction(() => {
		transcripts.save(
			db.mirror.db,
			id,
			transcript,
			JSON.stringify({ type: "session", id, cwd }),
			getFileStamp(transcript),
			(entries as { id: string; parentId?: string; type: string }[]).map((entry) => ({
				id: entry.id,
				parentId: entry.parentId ?? null,
				type: entry.type,
				json: JSON.stringify(entry),
			})),
			0,
		);
	});
	setCurrentSession("a");
	writeSessionRecord({
		session: "a",
		repository: registeredWorkspace(cwd).id,
		workspace: cwd,
		transcript,
		goal: { role: "user", text: "goal of a" },
		ending: [],
		toolCalls: 0,
	});
	setCurrentSession("me");
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const archive = fake.tools.get("archive");
	const ctx = fakeCtx({ cwd });
	return async (params: Record<string, unknown>) => {
		const out = await archive.execute("t1", params, undefined, undefined, ctx);
		return { text: out.content[0].text as string, details: out.details };
	};
}

/** Runs `work` while a 50 ms ticker records the longest event-loop stall. */
async function longestStall(work: () => Promise<unknown>): Promise<number> {
	let last = Date.now();
	let longest = 0;
	const ticker = setInterval(() => {
		longest = Math.max(longest, Date.now() - last);
		last = Date.now();
	}, 50);
	try {
		await work();
	} finally {
		clearInterval(ticker);
	}
	return Math.max(longest, Date.now() - last);
}

describe("archive errors bounds", () => {
	it("runs the errors query filter off the main thread and stops a runaway expression", async () => {
		// `(a+)+$` backtracks exponentially on a run of a's that does not end the text: many seconds for 29 of them.
		const call = archiveOver([result("bash", `${"a".repeat(29)}!`, true)]);
		const stall = await longestStall(() =>
			expect(call({ ...why, errors: true, query: "(a+)+$" })).rejects.toThrow(/exceeded 5 seconds/),
		);
		expect(stall).toBeLessThan(1_000);
	}, 30_000);

	it("keeps the errors a query matches, and the next-call follow-up of a kept group", async () => {
		const call = archiveOver([
			result("file", "Could not find the exact text in a.ts", true),
			result("file", "Path '/x' is outside allowed directories", true),
			result("file", "wrote 3 lines", false),
			result("bash", "Could not find the exact text in b.ts", true),
		]);
		const { text, details } = await call({ ...why, errors: true, query: "could not find" });
		expect(details).toMatchObject({ mode: "errors", hits: 2 });
		expect(text).toContain("oldText not found");
		expect(text).not.toContain("outside the allowed directories");
		// The file group's next file call was itself an error (filtered out), as without the worker.
		expect(text).toMatch(/next file call: ok 0 \(0\.0%\) · error again 1 \(100\.0%\) · none 0/);
	});

	it("signs an error with a very long first line in linear time", () => {
		// Shapes that made the path, id and trim patterns backtrack quadratically: dotted words, dashed hex-like runs and
		// a whitespace run followed by text.
		const line = `${"a.".repeat(30_000)} ${"a-".repeat(30_000)}g`;
		const started = performance.now();
		const plain = errorSignature(line);
		const command = errorSignature(`[exit 1 · 0s · 1 line]\nerror: ${line}`, "tsc --noEmit");
		const spaced = errorSignature(`[exit 1 · 0s · 1 line]\nerror:${" ".repeat(60_000)}x`, "tsc --noEmit");
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(plain.length).toBeLessThanOrEqual(160);
		expect(plain.startsWith("a.a.a.")).toBe(true);
		expect(command.startsWith("tsc exit 1: error: a.a.a.")).toBe(true);
		expect(spaced.startsWith("tsc exit 1: error:")).toBe(true);
	}, 30_000);
});
