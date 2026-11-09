import fs from "node:fs";
import path from "node:path";
import { setKeybindings } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { SessionInfo } from "../../src/core/session-manager.ts";
import type { SessionRemoval } from "../../src/core/session-picker.ts";
import { SessionSelectorComponent } from "../../src/modes/interactive/components/session-selector.ts";
import { handleDeleteSessions, handlePurge } from "../../src/modes/rpc/rpc-mode/session-delete.ts";
import { validateRpcCommand } from "../../src/modes/rpc/rpc-command-schema.ts";
import { pickerRemoval } from "../../src/octocode/sessions/delete.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { initTheme } from "../../src/theme/theme.ts";
import { tmp } from "./helpers.ts";

let saved: { home?: string; db?: string };
let home: string;

beforeAll(() => initTheme("dark"));

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
	saved = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
	home = fs.realpathSync(tmp());
	process.env.OCTOCODE_HOME = home;
	delete process.env.OCTOCODE_AGENT_DB;
});

afterEach(() => {
	closeSharedAgentDb();
	for (const [key, value] of [
		["OCTOCODE_HOME", saved.home],
		["OCTOCODE_AGENT_DB", saved.db],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** A saved session of a registered workspace: transcript, session folder and database row. */
function session(id: string, pid: number | null = null) {
	const root = fs.realpathSync(tmp("octocode-del-"));
	const identity = registeredWorkspace(root, sharedAgentDb());
	const state = path.join(root, ".octocode", "code");
	const file = path.join(state, "sessions", `${id}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root })}\n`,
	);
	const folder = path.join(state, "session-data", id);
	fs.mkdirSync(folder, { recursive: true });
	sharedAgentDb().db.prepare("INSERT INTO sessions (id, workspace_id, pid) VALUES (?, ?, ?)").run(id, identity.id, pid);
	const info: SessionInfo = {
		path: file,
		id,
		cwd: root,
		created: new Date(),
		modified: new Date(),
		messageCount: 1,
		firstMessage: `prompt ${id}`,
		allMessagesText: "",
	};
	return { file, folder, info };
}

describe("deleting sessions from the picker", () => {
	it("deletes every marked session: transcript, folder and rows", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const [one, two] = [session("s-one"), session("s-two")];
		const outcome = await pickerRemoval(index, () => undefined)([one.info, two.info]);
		expect(outcome.problems).toEqual([]);
		expect(outcome.removed.sort()).toEqual([one.file, two.file].sort());
		for (const target of [one.file, one.folder, two.file, two.folder]) expect(fs.existsSync(target)).toBe(false);
		expect(index.get("s-one")).toBeUndefined();
	});

	it("refuses a session another process runs, and the current one, and says why", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const [busy, current, plain] = [session("s-busy", process.pid), session("s-current"), session("s-plain")];
		const outcome = await pickerRemoval(index, () => "s-current")([busy.info, current.info, plain.info]);
		expect(outcome.removed).toEqual([plain.file]);
		expect(outcome.problems).toHaveLength(2);
		expect(outcome.problems.join("\n")).toContain(`pid ${process.pid}`);
		expect(outcome.problems.join("\n")).toContain("current session");
		for (const kept of [busy.file, current.file]) expect(fs.existsSync(kept)).toBe(true);
	});

	it("marks rows with Ctrl+X and deletes them with one confirmation, through the host's removal", async () => {
		const infos = ["a", "b", "c"].map((id) => session(`pick-${id}`).info);
		const calls: string[][] = [];
		const removeSessions = async (sessions: readonly SessionInfo[]): Promise<SessionRemoval> => {
			calls.push(sessions.map((s) => s.id));
			return { removed: sessions.map((s) => s.path), problems: [], method: "trash" };
		};
		const selector = new SessionSelectorComponent(
			async () => infos,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), removeSessions },
		);
		await new Promise((resolve) => setImmediate(resolve));
		const list = selector.getSessionList();
		const asked: Array<string[] | null> = [];
		list.onDeleteConfirmationChange = (paths) => asked.push(paths);
		const first = list.getSelectedSession()!;
		list.handleInput("\x18"); // Ctrl+X marks the first row and moves down
		const second = list.getSelectedSession()!;
		list.handleInput("\x18");
		expect(list.getCounts().marked).toBe(2);
		list.handleInput("\x04"); // Ctrl+D asks once for both
		expect(asked).toEqual([[first.path, second.path]]);
		list.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));
		expect(calls).toEqual([[first.id, second.id]]);
		expect(first.id).not.toBe(second.id);
		expect(list.getCounts().marked).toBe(0);
	});

	it("will not mark or delete a session that another process has open", async () => {
		const infos = [session("live-1").info];
		const selector = new SessionSelectorComponent(
			async () => infos,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager(), extras: () => new Map([["live-1", { live: true }]]) },
		);
		await new Promise((resolve) => setImmediate(resolve));
		const list = selector.getSessionList();
		const errors: string[] = [];
		const asked: unknown[] = [];
		list.onError = (message) => errors.push(message);
		list.onDeleteConfirmationChange = (paths) => asked.push(paths);
		list.handleInput("\x18");
		list.handleInput("\x04");
		expect(list.getCounts().marked).toBe(0);
		expect(asked).toEqual([]);
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("another Octocode process");
	});
});

describe("RPC", () => {
	const host = (sessionId: string, cwd: string) =>
		({ session: { sessionId, sessionManager: { getCwd: () => cwd } } }) as never;

	it("delete_sessions removes the listed sessions and refuses the current one", async () => {
		const [gone, current] = [session("rpc-gone"), session("rpc-current")];
		// Octocode lists sessions of the agent folder: put both where its listing finds them.
		const legacy = path.join(home, "sessions", "--legacy--");
		fs.mkdirSync(legacy, { recursive: true });
		for (const entry of [gone, current]) fs.copyFileSync(entry.file, path.join(legacy, path.basename(entry.file)));
		const response = await handleDeleteSessions(host("rpc-current", gone.info.cwd), {
			type: "delete_sessions",
			sessionIds: ["rpc-gone", "rpc-current", "missing"],
		});
		expect(response).toMatchObject({ success: true });
		const data = (response as { data: { removed: string[]; refused: unknown[]; notFound: string[] } }).data;
		expect(data.removed).toEqual(["rpc-gone"]);
		expect(data.refused).toEqual([{ id: "rpc-current", reason: "current" }]);
		expect(data.notFound).toEqual(["missing"]);
	});

	it("purge needs an explicit confirm: absent is invalid, false only previews", async () => {
		expect(validateRpcCommand({ type: "purge", scope: "workspace" })).toMatchObject({ ok: false });
		expect(validateRpcCommand({ type: "purge", scope: "everything", confirm: true })).toMatchObject({ ok: false });
		expect(validateRpcCommand({ type: "purge", scope: "workspace", confirm: true })).toEqual({ ok: true });
		const kept = session("rpc-keep");
		const response = await handlePurge(host("other", kept.info.cwd), {
			type: "purge",
			scope: "workspace",
			confirm: false,
		});
		expect(response).toMatchObject({ success: true, data: { purged: false } });
		expect(fs.existsSync(kept.file)).toBe(true);
		const done = await handlePurge(host("other", kept.info.cwd), { type: "purge", scope: "workspace", confirm: true });
		expect(done).toMatchObject({ success: true, data: { purged: true } });
		expect(fs.existsSync(kept.file)).toBe(false);
	});
});
