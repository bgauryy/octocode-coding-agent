import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { shouldCompact } from "../../src/core/compaction/index.ts";
import { splitSummary } from "../../src/core/compaction/summary-view.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { ArchiveCapture, archivePointer } from "../../src/octocode/compaction/archive.ts";
import { liveStateLines } from "../../src/octocode/compaction/live-state.ts";
import {
	deliverRestoredFiles,
	RESTORE_TOTAL_CHARS,
	settleRestoredFiles,
} from "../../src/octocode/compaction/restore.ts";
import { writeSummary } from "../../src/octocode/compaction/summary.ts";
import { RESTORED_FILES_TYPE } from "../../src/octocode/files/reads.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { archiveFolder, readSegments, segmentPath } from "../../src/octocode/history/archive.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { fakeCtx, fakeHost, asSetup } from "./fake-host.ts";

/**
 * What survives a compaction, seen from the model's side: the state it is told is live, what it can search for later,
 * what a second compaction keeps of the first, what a resumed session starts from and which file text it holds. Each
 * test asserts facts (ids, tokens, file content, counts), never the wording of an instruction.
 */

const SESSION = "session-recall";
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-recall-")));
	saved = { db: process.env.OCTOCODE_AGENT_DB, home: process.env.OCTOCODE_HOME };
	process.env.OCTOCODE_AGENT_DB = path.join(root, "db", "octocode.db");
	process.env.OCTOCODE_HOME = path.join(root, "home");
	fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
	setCurrentSession(SESSION);
});
afterEach(() => {
	setCurrentSession(undefined);
	closeSharedAgentDb();
	for (const [key, name] of [
		["db", "OCTOCODE_AGENT_DB"],
		["home", "OCTOCODE_HOME"],
	] as const) {
		if (saved[key] === undefined) delete process.env[name];
		else process.env[name] = saved[key];
	}
	fs.rmSync(root, { recursive: true, force: true });
});

const cwd = () => path.join(root, "repo");
const T0 = Date.UTC(2026, 4, 1, 10, 0, 0);

describe("live state after a compaction", () => {
	const ctx = () =>
		({
			cwd: cwd(),
			sessionManager: { getSessionId: () => SESSION, getSessionFile: () => undefined, getHeader: () => null },
		}) as never;

	const start = (id: string, tool: string, args: Record<string, unknown>, details: Record<string, unknown>) => [
		{
			type: "message",
			timestamp: new Date(5_000).toISOString(),
			message: { role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: args }] },
		},
		{
			type: "message",
			timestamp: new Date(5_000).toISOString(),
			message: { role: "toolResult", toolCallId: id, toolName: tool, isError: false, details },
		},
	];

	it("carries the running job and the pending child into the summary the next model reads, and never says no item is held", async () => {
		const agent = sharedAgentDb();
		const store = new BacklogStore(() => agent, registeredWorkspace(cwd(), agent).id);
		store.add({ title: "Fix the parser", goal: "g", why: "Required work", state: "todo", createdBy: "agent" });
		store.update("B1", { state: "ongoing" }, { id: SESSION });
		const branch = [
			...start("j1", "bash", { command: "yarn test-marker" }, { job: "bash-7", log: "/logs/bash-7.log" }),
			...start("a1", "agent", { goal: "review-marker", task: "t" }, { status: "background", id: "calm-otter" }),
		];
		const model = { provider: "p", id: "m", api: "anthropic-messages", maxTokens: 10_000, contextWindow: 200_000 };
		// The model's own summary names a finished item and nothing live: the tools' state must still reach the next model.
		const reply = {
			role: "assistant",
			content: [{ type: "text", text: "## Goal\nFinish B9" }],
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			timestamp: 1,
		};
		const out = await writeSummary(
			asSetup({
				getThinkingLevel: () => "off",
				getActiveTools: () => [],
				getSettings: () => ({}),
				createUsageRecorder: () => () => {},
				appendEntry: () => {},
			}) as never,
			{
				preparation: {
					firstKeptEntryId: "k",
					tokensBefore: 1,
					messagesToSummarize: [{ role: "user", content: "go" }],
					turnPrefixMessages: [],
					isSplitTurn: false,
					fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
					settings: { reserveTokens: 10_000 },
				},
				branchEntries: branch,
				signal: { aborted: false },
			} as never,
			{
				model,
				modelRegistry: { getCachePolicy: () => ({ options: {} }), streamSimple: () => ({ result: async () => reply }) },
				sessionManager: {
					getSessionId: () => SESSION,
					getHeader: () => null,
					// A writable session file: the paid summary is saved beside it.
					getSessionFile: () => path.join(root, "s.jsonl"),
					getBranch: () => [],
					buildSessionProjection: () => ({ entries: [], messages: [] }),
				},
				hasUI: false,
			} as never,
			undefined,
			undefined,
			undefined,
			undefined,
			() => liveStateLines(ctx(), branch, 0),
		);
		const { summary } = out!.compaction!;
		const recovery = summary.slice(summary.indexOf("## Recovery"));
		// A held item is listed once, by the session-state brief sent after the compaction; Recovery names it only as "none".
		expect(recovery).not.toContain("B1");
		expect(recovery).not.toContain("holds: none");
		expect(recovery).toContain("bash-7");
		expect(recovery).toContain("/logs/bash-7.log");
		expect(recovery).toContain("calm-otter");
		// The live state is code-written Recovery, so it never counts as the model's own summary text.
		expect(splitSummary(summary).body).not.toContain("calm-otter");
	});

	it("stops naming a job or child once its report arrived", () => {
		const branch = [
			...start("j1", "bash", { command: "yarn done-marker" }, { job: "bash-7", log: "/logs/bash-7.log" }),
			...start("a1", "agent", { goal: "g", task: "t" }, { status: "background", id: "calm-otter" }),
			{ type: "custom_message", customType: "octocode-bash-job", details: { id: "bash-7", log: "/logs/bash-7.log" } },
			{ type: "custom_message", customType: "octocode-agent-result", details: { id: "calm-otter" } },
		];
		const text = liveStateLines(ctx(), branch, 0).join("\n");
		expect(text).not.toContain("bash-7");
		expect(text).not.toContain("calm-otter");
	});
});

/** A segment-writing compaction, as `session_before_compact` captures it and `session_compact` files it. */
function compact(messages: Array<Record<string, unknown>>, n: number, tldr: string): void {
	const entries = messages.map((message, index) => ({
		type: "message",
		id: `m${n}-${index}`,
		timestamp: new Date(message.timestamp as number).toISOString(),
		message,
	}));
	const capture = new ArchiveCapture();
	capture.capture({
		preparation: {
			firstKeptEntryId: `keep${n}`,
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			tokensBefore: 50_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
		},
		branchEntries: entries,
	} as never);
	const written = capture.write(
		{
			type: "compaction",
			id: `c${n}`,
			summary: `## Goal\n${tldr}`,
			firstKeptEntryId: `keep${n}`,
			tokensBefore: 50_000,
			details: {},
			fromHook: false,
		} as never,
		SESSION,
		{ topics: [], goal: tldr },
		"pi-default",
	);
	expect(written?.n).toBe(n);
}

const user = (text: string, minute: number) => ({ role: "user", content: text, timestamp: T0 + minute * 60_000 });

function archiveSearcher() {
	const fake = fakeHost();
	registerArchiveTool(fake.api);
	const tool = fake.tools.get("archive");
	const ctx = fakeCtx({ cwd: cwd() });
	return async (params: Record<string, unknown>) => {
		const result = await tool.execute(
			"t1",
			{ reason: "recall a fact from before compaction", ...params },
			undefined,
			undefined,
			ctx,
		);
		return String(result.content[0].text);
	};
}

describe("history search after compaction", () => {
	it("finds a fact that only the summarized messages held, by regex and by keywords", async () => {
		compact(
			[user("The staging database host is zq-fjord-7731.internal", 0), user("noted", 1)],
			1,
			"database host work",
		);
		const search = archiveSearcher();
		expect(await search({ source: "compactions", query: "zq-fjord-7731" })).toContain("zq-fjord-7731.internal");
		expect(await search({ source: "compactions", keywords: "zq-fjord-7731" })).toContain("zq-fjord-7731");
	});

	it("keeps the first segment whole and findable when a second compaction follows", async () => {
		compact([user("first-era fact: alpha-quokka-001", 0)], 1, "first era");
		const first = segmentPath(1)!;
		const before = fs.readFileSync(first);
		compact([user("second-era fact: beta-narwhal-002", 10)], 2, "second era");

		expect(readSegments().map((segment) => segment.n)).toEqual([1, 2]);
		expect(fs.readFileSync(first).equals(before)).toBe(true);
		const search = archiveSearcher();
		expect(await search({ source: "compactions", query: "alpha-quokka-001" })).toContain("alpha-quokka-001");
		expect(await search({ source: "compactions", query: "beta-narwhal-002" })).toContain("beta-narwhal-002");
		// The library indexes both segments, and the next compaction's pointer names the earlier one.
		const library = fs.readFileSync(path.join(archiveFolder(), "LIBRARY.md"), "utf8");
		expect(library).toContain("first era");
		expect(library).toContain("second era");
		expect(archivePointer(3).join("\n")).toContain("second era");
		expect(archivePointer(3).join("\n")).toContain("first era");
	});

	it("does not file a compaction that was cancelled, so the next segment number stays contiguous", () => {
		compact([user("one", 0)], 1, "one");
		const abandoned = new ArchiveCapture();
		abandoned.capture({
			preparation: {
				firstKeptEntryId: "x",
				messagesToSummarize: [user("never compacted", 5)],
				turnPrefixMessages: [],
			},
			branchEntries: [],
		} as never);
		abandoned.discard();
		compact([user("two", 10)], 2, "two");
		expect(readSegments().map((segment) => segment.n)).toEqual([1, 2]);
	});
});

describe("resuming a compacted session", () => {
	const assistant = (text: string, at: number) =>
		({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: at,
		}) as never;

	it("starts from the newest summary plus the kept messages, not from the summarized ones", () => {
		const sessions = path.join(root, "sessions");
		const sm = SessionManager.create(cwd(), sessions);
		sm.appendMessage({ role: "user", content: "OLD-ASK first request", timestamp: 1 });
		sm.appendMessage(assistant("OLD-REPLY", 2));
		const keptUser = sm.appendMessage({ role: "user", content: "KEPT-ASK second request", timestamp: 3 });
		sm.appendMessage(assistant("KEPT-REPLY", 4));
		sm.appendCompaction("## Goal\nFIRST-SUMMARY", keptUser, 1_000, {});
		sm.appendMessage({ role: "user", content: "MIDDLE-ASK", timestamp: 5 });
		sm.appendMessage(assistant("MIDDLE-REPLY", 6));
		const midKept = sm.appendMessage({ role: "user", content: "LATE-ASK", timestamp: 7 });
		sm.appendMessage(assistant("LATE-REPLY", 8));
		sm.appendCompaction("## Goal\nSECOND-SUMMARY", midKept, 2_000, {});
		const file = sm.getSessionFile()!;
		expect(fs.existsSync(file)).toBe(true);

		const resumed = SessionManager.open(file, sessions);
		const context = JSON.stringify(resumed.buildSessionProjection().messages);
		expect(context).toContain("SECOND-SUMMARY");
		expect(context).toContain("LATE-ASK");
		expect(context).toContain("LATE-REPLY");
		// The first summary was folded into the second one; the summarized turns are gone from the request.
		for (const gone of ["FIRST-SUMMARY", "OLD-ASK", "OLD-REPLY", "KEPT-ASK", "MIDDLE-ASK", "MIDDLE-REPLY"])
			expect(context).not.toContain(gone);
		// ...but the stored file still holds all of it, for the archive and /tree.
		const stored = fs.readFileSync(file, "utf8");
		for (const kept of ["OLD-ASK", "FIRST-SUMMARY", "SECOND-SUMMARY"]) expect(stored).toContain(kept);
	});
});

describe("files after a compaction", () => {
	it("hands the model the file's current disk text, not what it read before the compaction", async () => {
		const file = path.join(cwd(), "w.ts");
		fs.writeFileSync(file, "export const v = 'BEFORE-COMPACTION';\n");
		const worked = [{ file, workedAt: 1, line: 1 }];
		// The file changes after the model read it (a peer, a formatter, a bash write) and before the compaction lands.
		fs.writeFileSync(file, "export const v = 'LATEST-ON-DISK';\n");
		const sent: Array<{ content: string; details: { id: string } }> = [];
		const api = asSetup({
			sendMessage: (message: never) => {
				sent.push(message);
			},
		});
		const pending = (await deliverRestoredFiles(
			api,
			worked,
			{ cwd: cwd(), sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ entries: [] }) } } as never,
			RESTORE_TOTAL_CHARS,
		))!;
		expect(sent).toHaveLength(1);
		expect(sent[0].content).toContain("LATEST-ON-DISK");
		expect(sent[0].content).not.toContain("BEFORE-COMPACTION");

		// Once a model call carries it, the guard counts the file as read, so an edit against that text goes through.
		const guard = new FileGuard();
		guard.restore([]);
		const carried = [{ role: "custom", customType: RESTORED_FILES_TYPE, details: sent[0].details, content: "" }];
		expect(settleRestoredFiles(carried as never, pending, guard)).toBe(true);
		expect(guard.check(file, "edit", "w.ts")).toBeUndefined();
	});

	it("does not count a restored file as read when the file changed again before the model call carried it", async () => {
		const file = path.join(cwd(), "x.ts");
		fs.writeFileSync(file, "one\n");
		const sent: Array<{ details: { id: string } }> = [];
		const pending = (await deliverRestoredFiles(
			asSetup({ sendMessage: (message: never) => void sent.push(message) }) as never,
			[{ file, workedAt: 1, line: 1 }],
			{ cwd: cwd(), sessionManager: { getBranch: () => [], buildSessionProjection: () => ({ entries: [] }) } } as never,
			RESTORE_TOTAL_CHARS,
		))!;
		fs.writeFileSync(file, "two, longer\n");
		fs.utimesSync(file, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
		const guard = new FileGuard();
		guard.restore([]);
		settleRestoredFiles(
			[{ role: "custom", customType: RESTORED_FILES_TYPE, details: sent[0].details, content: "" }] as never,
			pending,
			guard,
		);
		// The model holds "one"; a whole-file write over "two, longer" must ask for a fresh read.
		expect(guard.check(file, "write", "x.ts")).toBeTruthy();
	});
});

describe("when compaction triggers", () => {
	const settings = { enabled: true, reserveTokens: 16_000, keepRecentTokens: 20_000 };

	it("compacts only above window minus reserve, never when disabled or when the window is unknown", () => {
		expect(shouldCompact(84_000, 100_000, settings)).toBe(false);
		expect(shouldCompact(84_001, 100_000, settings)).toBe(true);
		expect(shouldCompact(1_000_000, 100_000, { ...settings, enabled: false })).toBe(false);
		expect(shouldCompact(1_000_000, 0, settings)).toBe(false);
	});
});
