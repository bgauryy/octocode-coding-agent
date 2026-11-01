import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { buildSessionInfo } from "../../src/core/session-manager/listing.ts";
import { getDefaultSessionDirPath } from "../../src/core/session-manager/storage.ts";
import { closeSharedAgentDb, sharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { quickList } from "../../src/octocode/sessions/catalog.ts";
import { registerSessions } from "../../src/octocode/sessions/register.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: { home?: string; db?: string };
let cwd: string;
let dir: string;

beforeEach(() => {
	saved = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
	process.env.OCTOCODE_HOME = tmp();
	delete process.env.OCTOCODE_AGENT_DB;
	cwd = tmp();
	dir = path.join(tmp(), "sessions");
});

afterEach(() => {
	vi.restoreAllMocks();
	closeSharedAgentDb();
	for (const [key, value] of [
		["OCTOCODE_HOME", saved.home],
		["OCTOCODE_AGENT_DB", saved.db],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const index = () => new SessionIndex(sharedAgentDb());

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: Date.now() });
const reply = (text: string) =>
	({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "p",
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
		timestamp: Date.now(),
	}) as never;

/** A saved session of `turns` exchanges. */
function session(first = "Fix the login bug", turns = 1): SessionManager {
	const manager = SessionManager.create(cwd, dir);
	for (let turn = 0; turn < turns; turn++) {
		manager.appendMessage(user(turn === 0 ? first : `more ${turn}`));
		manager.appendMessage(reply(`done ${turn}`));
	}
	return manager;
}

/** Host with the sessions feature, whose live session is `manager`. */
function host(manager: SessionManager) {
	const fake = fakeHost();
	Object.assign(fake.api, {
		setSessionName: (name: string, source?: "user" | "auto" | "goal") => manager.appendSessionInfo(name, source),
	});
	registerSessions(fake.api, { commands: new Subcommands(), isSubagent: false });
	const ctx = fakeCtx({ cwd });
	Object.assign(ctx, { sessionManager: manager });
	return { fake, ctx };
}

describe("session catalog", () => {
	it("writes the catalog row when a turn ends, with the listing's own numbers", async () => {
		const manager = session("Fix the login bug", 2);
		const { fake, ctx } = host(manager);
		await fake.fire("agent_end", { type: "agent_end", messages: [] }, ctx);

		const row = index().catalog({ cwd })[0];
		const parsed = (await buildSessionInfo(manager.getSessionFile()!))!;
		expect(row).toMatchObject({
			id: manager.getSessionId(),
			file: manager.getSessionFile(),
			cwd,
			title: null,
			title_source: null,
			first_prompt: "Fix the login bug",
			message_count: 4,
		});
		expect(row.message_count).toBe(parsed.messageCount);
		expect(row.created_at).toBe(parsed.created.getTime());
		expect(row.last_active).toBe(parsed.modified.getTime());
		expect(row.file_mtime).toBe(Math.floor(fs.statSync(manager.getSessionFile()!).mtimeMs));
	});

	it("keeps the first prompt to 200 characters and shows a skill request, not its body", async () => {
		const body = "x".repeat(5000);
		const manager = session(
			`<skill name="octocode-architect" location="/s/SKILL.md">\n${body}\n</skill>\n\nreview the layering`,
		);
		const { fake, ctx } = host(manager);
		await fake.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		const row = index().catalog()[0];
		expect(row.first_prompt).toBe("octocode-architect: review the layering");
		const long = session("y".repeat(900));
		const second = host(long);
		await second.fake.fire("agent_end", { type: "agent_end", messages: [] }, second.ctx);
		expect(
			index()
				.catalog()
				.find((each) => each.id === long.getSessionId())!.first_prompt!.length,
		).toBeLessThanOrEqual(200);
	});

	it("records a rename with its source", async () => {
		const manager = session();
		const { fake, ctx } = host(manager);
		await fake.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		manager.appendSessionInfo("Login work");
		await fake.fire("session_info_changed", { type: "session_info_changed", name: "Login work" }, ctx);
		expect(index().catalog()[0]).toMatchObject({ title: "Login work", title_source: "user" });
		manager.appendSessionInfo("Fix login", "auto");
		await fake.fire("session_info_changed", { type: "session_info_changed", name: "Fix login", source: "auto" }, ctx);
		expect(index().catalog()[0]).toMatchObject({ title: "Fix login", title_source: "auto" });
		manager.appendSessionInfo(" ");
		await fake.fire("session_info_changed", { type: "session_info_changed", name: undefined }, ctx);
		expect(index().catalog()[0]).toMatchObject({ title: null, title_source: null });
	});

	it("lists from rows without parsing, then re-parses only a file changed since its row", async () => {
		const quiet = session("Quiet session");
		const live = session("Edited session");
		await fake(quiet);
		await fake(live);
		const parse = vi.fn((file: string) => buildSessionInfo(file));

		const warm = await quickList(index(), { sessionDir: dir }, parse);
		expect(parse).not.toHaveBeenCalled();
		expect(warm.map((info) => info.firstMessage).sort()).toEqual(["Edited session", "Quiet session"]);
		expect(warm.every((info) => info.allMessagesText === "")).toBe(true);

		// Another process appends to one transcript.
		const file = live.getSessionFile()!;
		const entry = {
			type: "message",
			id: "zz01",
			parentId: live.getLeafId(),
			timestamp: new Date().toISOString(),
			message: user("one more thing"),
		};
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
		const later = new Date(Date.now() + 5000);
		fs.utimesSync(file, later, later);

		const changed = await quickList(index(), { sessionDir: dir }, parse);
		expect(parse.mock.calls.map(([called]) => called)).toEqual([file]);
		expect(changed.find((info) => info.path === file)!.messageCount).toBe(3);
		expect(changed.find((info) => info.path === file)!.allMessagesText).toContain("one more thing");

		// The parse backfilled the row: the next listing needs none.
		parse.mockClear();
		await quickList(index(), { sessionDir: dir }, parse);
		expect(parse).not.toHaveBeenCalled();
		expect(
			index()
				.catalog()
				.find((row) => row.file === file)!.message_count,
		).toBe(3);

		async function fake(manager: SessionManager) {
			const { fake: events, ctx } = host(manager);
			await events.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
		}
	});

	it("parses and backfills a session file that has no row, and skips files that are not sessions", async () => {
		const manager = session("Never indexed");
		fs.writeFileSync(path.join(dir, "notes.jsonl"), "not a session\n");
		const listed = await quickList(index(), { sessionDir: dir });
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({ id: manager.getSessionId(), firstMessage: "Never indexed", messageCount: 2 });
		expect(listed[0].allMessagesText).toContain("done 0");
		expect(index().catalog()[0]).toMatchObject({ file: manager.getSessionFile(), message_count: 2 });
	});

	it("lists a scope by working directory and sorts by activity", async () => {
		// The default folder of this (unique) working directory, removed afterwards.
		const home = getDefaultSessionDirPath(cwd);
		fs.mkdirSync(home, { recursive: true });
		onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
		const older = SessionManager.create(cwd, home);
		older.appendMessage(user("older"));
		older.appendMessage(reply("ok"));
		await new Promise((resolve) => setTimeout(resolve, 15));
		const newer = SessionManager.create(cwd, home);
		newer.appendMessage(user("newer"));
		newer.appendMessage(reply("ok"));
		const listed = await quickList(index(), { cwd });
		expect(listed.map((info) => info.firstMessage)).toEqual(["newer", "older"]);
	});
});
