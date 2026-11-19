import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { closeSharedAgentDb, timers } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { liveStateLines } from "../../src/octocode/compaction/live-state.ts";
import { compactionRequestBrief } from "../../src/octocode/sessions/compaction-brief.ts";
import { registerSessions } from "../../src/octocode/sessions/register.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const SESSION = "session-jobs";
let dir: string;
let savedDb: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-job-state-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	savedHome = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_AGENT_DB = path.join(dir, "home", "octocode.db");
	process.env.OCTOCODE_HOME = path.join(dir, "octo-home");
	fs.mkdirSync(path.join(dir, "repo"), { recursive: true });
});
afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = savedHome;
	fs.rmSync(dir, { recursive: true, force: true });
});

const cwd = () => path.join(dir, "repo");
const ctx = () =>
	({ cwd: cwd(), sessionManager: { getSessionId: () => SESSION, getSessionFile: () => undefined } }) as never;

const job = (id: string, args: Record<string, unknown>, log: string) => [
	{
		type: "message",
		timestamp: new Date(2_000).toISOString(),
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: args }] },
	},
	{
		type: "message",
		timestamp: new Date(2_000).toISOString(),
		message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, details: { job: "bash-1", log } },
	},
];

describe("active timers in the compaction live state (A)", () => {
	it("names each active timer with what it waits for, its note and when it is due, and not an ended one", () => {
		const agent = sharedAgentDb();
		const workspaceId = registeredWorkspace(cwd(), agent).id;
		const at = Date.UTC(2026, 10, 15, 12, 0, 0);
		timers.insert(agent.db, {
			workspaceId,
			sessionId: SESSION,
			note: "check the deploy",
			kind: "once",
			dueAt: at + 600_000,
			at,
		});
		const gone = timers.insert(agent.db, {
			workspaceId,
			sessionId: SESSION,
			note: "already finished",
			kind: "once",
			dueAt: at,
			at,
		});
		timers.insert(agent.db, {
			workspaceId,
			sessionId: "other-session",
			note: "peer timer",
			kind: "once",
			dueAt: at,
			at,
		});
		agent.db.prepare("UPDATE timers SET status = 'done' WHERE id = ?").run(gone.id);
		const text = liveStateLines(ctx(), [], 0).join("\n");
		expect(text).toContain("check the deploy");
		expect(text).toMatch(/#\d+/);
		expect(text).toContain(new Date(at + 600_000).toISOString());
		expect(text).not.toContain("already finished");
		expect(text).not.toContain("peer timer");
	});

	it("says nothing about timers when none is active", () => {
		expect(liveStateLines(ctx(), [], 0).join("\n")).not.toMatch(/timer/i);
	});
});

describe("a long job command never costs its id, reason or log (B)", () => {
	it("keeps the whole reason and log path while the command is shortened", () => {
		const log = `/home/user/.octocode/logs/${"deep/".repeat(12)}bash-1-1700000000.log`;
		const why = "Run the whole suite so the flaky retry can be compared with the last run";
		const command = `run-tests ${"argument ".repeat(500)} --final-check`;
		const entries = job("c1", { command, reason: why }, log);
		const text = liveStateLines(ctx(), entries, 1_000).join("\n");
		expect(text).toContain("bash-1");
		expect(text).toContain(`why "${why}"`);
		expect(text).toContain(log);
		expect(text).toContain("characters omitted");
		expect(text.length).toBeLessThan(2_000);
	});
});

describe("job lines are said once per compaction (C)", () => {
	async function compact(withRequest: boolean, reply?: string) {
		const sm = SessionManager.create(cwd(), path.join(dir, "sessions"));
		const fake = fakeHost();
		const context = fakeCtx({ cwd: cwd(), mode: "tui" }) as unknown as Record<string, any>;
		context.sessionManager = sm;
		registerSessions(fake.api, { commands: new Subcommands(), isSubagent: false });
		await fake.emit("session_start", { reason: "startup" }, context);
		if (withRequest) sm.appendMessage({ role: "user", content: "please fix the parser", timestamp: Date.now() });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "yarn test", reason: "suite" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			isError: false,
			content: [{ type: "text", text: "started" }],
			details: { job: "bash-1", log: "/logs/bash-1.log" },
			timestamp: Date.now(),
		} as never);
		if (reply)
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: reply }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			} as never);
		await fake.emit("session_compact", { type: "session_compact", compactionEntry: undefined }, context);
		return fake.sent.map((item) => String(item.message.content)).join("\n");
	}

	it("leaves the job lines to the summary's live state, not the session-state message", async () => {
		const sent = await compact(true);
		expect(sent).toContain("please fix the parser");
		expect(sent).not.toContain("bash-1");
		expect(sent).not.toContain("yarn test");
	});

	it("sends no session-state message when only jobs would be in it", async () => {
		expect(await compact(false)).toBe("");
	});

	it("carries the lead of the last reply the compaction folded away, cut to a bound", async () => {
		const sent = await compact(
			true,
			`Fixed the lexer; next I run the parser tests.\n\n| Test | Result |\n| --- | --- |\n| lexer | pass |`,
		);
		expect(sent).toContain('Your last reply before the compaction: "Fixed the lexer; next I run the parser tests."');
		expect(sent).not.toContain("| Test |");
		const long = await compact(true, `Fixed it. ${"detail ".repeat(400)}`);
		expect(long.length).toBeLessThan(1_500);
	});
});

describe("a cut request excerpt agrees with the session file it names", () => {
	it("does not say no file keeps the text when the session file is named", () => {
		const note = compactionRequestBrief("word ".repeat(2_000), undefined, "/sessions/s.jsonl") ?? "";
		expect(note).toContain("complete text in /sessions/s.jsonl");
		expect(note).toContain("characters omitted");
		expect(note).not.toContain("no file");
	});

	it("says no file keeps the text when the session has none", () => {
		expect(compactionRequestBrief("word ".repeat(2_000), undefined, undefined)).toContain("no file");
	});
});
