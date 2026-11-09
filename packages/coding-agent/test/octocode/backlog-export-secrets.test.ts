import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { exportMarkdown } from "../../src/octocode/backlog/format.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const SECRET = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-export-secrets-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup() {
	const fake = fakeHost();
	const commands = new Subcommands();
	registerBacklog(fake.api, { commands, isSubagent: false, open: async () => undefined });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const repo = registeredWorkspace(cwd).id;
	const store = new BacklogStore(() => sharedAgentDb(), repo);
	for (const title of ["one", "two", "three"])
		store.add({ title, goal: "g", why: "Required work", state: "todo", createdBy: "agent" });
	return {
		cwd,
		repo,
		store,
		command: commands.get("backlog")!,
		file: path.join(cwd, ".octocode", "code", "backlog.md"),
		body: (seq: number, text: string) =>
			sharedAgentDb().db.prepare("UPDATE backlog SET body = ? WHERE seq = ? AND workspace_id = ?").run(text, seq, repo),
	};
}

describe("/backlog export refuses stored secrets like /backlog html", () => {
	it("refuses a secret in an item's body and writes no file", async () => {
		const t = setup();
		// Text stored before the write-time check, or by another build, bypasses it: plant it directly.
		t.body(3, `token at ${SECRET}`);
		const ctx = fakeCtx({ cwd: t.cwd });
		await t.command.handler("export", ctx);
		expect(ctx.ui.notes.at(-1)).toMatchObject({
			type: "error",
			message: expect.stringMatching(
				/Export failed: Not written: the body of B3 looks like it contains a GitHub token/,
			),
		});
		expect(fs.existsSync(t.file)).toBe(false);
	});

	it("refuses a secret in a note and leaves an earlier export untouched", async () => {
		const t = setup();
		await t.command.handler("export", fakeCtx({ cwd: t.cwd }));
		const before = fs.readFileSync(t.file, "utf8");
		sharedAgentDb()
			.db.prepare("INSERT INTO backlog_notes (item, at, author, kind, text) VALUES (?, 1, 'agent', 'note', ?)")
			.run(t.store.get("B2")!.rowId, `see ${SECRET}`);
		const ctx = fakeCtx({ cwd: t.cwd });
		await t.command.handler("export", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(
			/Not written: the note \d+ of B2 looks like it contains a GitHub token/,
		);
		expect(fs.readFileSync(t.file, "utf8")).toBe(before);
	});

	it("refuses a repository name that looks like a secret", () => {
		const t = setup();
		expect(() => exportMarkdown(t.store, SECRET, NOW)).toThrow(/Not written: the repository name/);
	});

	it("does not refuse on text the markdown does not carry (an audit row)", async () => {
		const t = setup();
		sharedAgentDb()
			.db.prepare(
				"INSERT INTO backlog_audits (workspace_id, backlog_id, at, actor, action, entity, after_value) VALUES (?, 'B1', 1, 'x', 'insert', 'backlog', ?)",
			)
			.run(t.repo, JSON.stringify({ body: SECRET }));
		const ctx = fakeCtx({ cwd: t.cwd });
		await t.command.handler("export", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toMatch(/^Exported the backlog to /);
		expect(fs.readFileSync(t.file, "utf8")).not.toContain(SECRET);
	});
});
