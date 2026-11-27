import { getFileStamp } from "@octocodeai/octocode-common/paths";
import { sessions, transcripts } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { writeSessionRecord } from "../../src/octocode/history/archive/record.ts";
import { archiveFolder } from "../../src/octocode/history/archive.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { encodeSessionLines } from "../../src/core/session-manager/codec.ts";
import { tmp } from "./helpers.ts";
import { parseAnchor } from "@octocodeai/octocode-contracts/evidence";
import { readEvidence } from "../../src/octocode/archive/evidence.ts";

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

function repo(): string {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	return cwd;
}

let entry = 0;
const model = (modelId: string) => ({ type: "model_change", id: `m${entry++}`, provider: "p", modelId });
const result = (day: string, toolName: string, text: string, isError: boolean, callId?: string) => ({
	type: "message",
	id: `e${entry++}`,
	timestamp: `${day}T10:00:00.000Z`,
	message: {
		role: "toolResult",
		toolCallId: callId ?? `toolu_${entry}`,
		toolName,
		content: [{ type: "text", text }],
		isError,
	},
});
/** A session of `cwd`'s repository whose record names a transcript of `entries` at `transcript`. */
function session(
	id: string,
	cwd: string,
	transcript: string,
	entries: unknown[],
	mirrored = true,
	encoded = false,
): void {
	fs.mkdirSync(path.dirname(transcript), { recursive: true });
	// `encoded`: as the session codec writes a file now (bash outputs as spans, system parts by reference).
	const lines = encoded ? encodeSessionLines(entries as object[]).lines : entries.map((line) => JSON.stringify(line));
	fs.writeFileSync(transcript, lines.join("\n") + "\n");
	if (mirrored) {
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
	}
	setCurrentSession(id);
	writeSessionRecord({
		session: id,
		repository: registeredWorkspace(cwd).id,
		workspace: cwd,
		transcript,
		goal: { role: "user", text: `goal of ${id}` },
		ending: [],
		toolCalls: 0,
	});
	setCurrentSession("me");
}

function tool(cwd: string) {
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const archive = fake.tools.get("archive");
	const ctx = fakeCtx({ cwd });
	return async (params: Record<string, unknown>) => {
		const out = await archive.execute("t1", params, undefined, undefined, ctx);
		return { text: out.content[0].text as string, details: out.details };
	};
}

const call = (id: string, name: string, args: object) => ({
	type: "message",
	id: `a${entry++}`,
	timestamp: "2026-10-25T10:00:00.000Z",
	message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});

describe("archive search covers full transcripts", () => {
	function scripted(cwd: string) {
		const failing = result("2026-10-25", "localFetch", "Tool localFetch not found", true, "toolu_01Abc");
		session("s1", cwd, path.join(process.env.OCTOCODE_HOME!, "sessions", "s1.jsonl"), [
			model("m"),
			call("toolu_01Abc", "localFetch", { path: "/x", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }),
			failing,
		]);
		return failing.id;
	}

	it("finds a tool result's text and a toolCallId, and names what it searched", async () => {
		const cwd = repo();
		const resultId = scripted(cwd);
		const run = tool(cwd);
		const text = await run({ ...why, query: "Tool localFetch not found" });
		expect(text.text).toContain(`transcript:s1/${resultId}`);
		expect(text.text).toContain("Transcripts (full messages, tool calls and results): 1 of 1 session read");
		expect(text.text).toContain("Every archive file was read.");
		expect(text.details).toMatchObject({ history: { mode: "search", hits: 1 } });
		const byId = await run({ ...why, query: "toolu_01Abc" });
		// The call and its result both carry the id.
		expect(byId.details).toMatchObject({ history: { hits: 2 } });
	});

	it("says transcripts were not searched when a file narrows the search", async () => {
		const cwd = repo();
		scripted(cwd);
		const out = await tool(cwd)({ ...why, query: "Tool localFetch", file: archiveFolder("s1") }).catch((e: Error) => ({
			text: e.message,
		}));
		expect(out.text).not.toContain("Transcripts (full");
	});

	it("shows an errors sample's emitted call, redacted, and ids that open both entries", async () => {
		const cwd = repo();
		const resultId = scripted(cwd);
		const run = tool(cwd);
		const { text } = await run({ ...why, errors: true });
		expect(text).toMatch(/emitted: localFetch \{"path":"\/x","token":"\[redacted\]"\}/);
		expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
		const ids = [...text.matchAll(/get id: (.*)$/gm)][0][1];
		expect(ids).toContain(`transcript:s1/${resultId}`);
		const callId = /(transcript:s1\/a\d+) \(call\)/.exec(ids)![1];
		const opened = await readEvidence(cwd, parseAnchor(callId)!);
		expect(opened.text).toContain("[call localFetch toolu_01Abc]");
		const result_ = await readEvidence(cwd, parseAnchor(`transcript:s1/${resultId}`)!);
		expect(result_.text).toContain("Tool localFetch not found");
	});
});
