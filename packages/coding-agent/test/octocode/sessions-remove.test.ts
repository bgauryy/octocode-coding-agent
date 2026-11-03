import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { removeSessions } from "../../src/octocode/sessions/remove.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { tmp } from "./helpers.ts";

let saved: { home?: string; db?: string };
let home: string;

beforeEach(() => {
	saved = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
	home = tmp();
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

function fixture(id: string, pid: number | null = null) {
	const root = fs.realpathSync(tmp("octocode-rm-"));
	const workspace = registeredWorkspace(root, sharedAgentDb());
	const state = path.join(workspace.root, ".octa", "code");
	const file = path.join(state, "sessions", `${id}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd: root })}\n`);
	const folders = [path.join(state, "session-data", id), path.join(state, "temp", "sessions", id)];
	for (const folder of folders) fs.mkdirSync(path.join(folder, "output"), { recursive: true });
	sharedAgentDb()
		.db.prepare("INSERT INTO sessions (id, workspace_id, pid) VALUES (?, ?, ?)")
		.run(id, workspace.id, pid);
	return { file, folders, cwd: root };
}

describe("removeSessions", () => {
	it("removes the transcript, both folders of the session's own workspace and its rows, whatever the current cwd", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const one = fixture("s-one");
		const two = fixture("s-two");
		const result = await removeSessions(
			index,
			[
				{ id: "s-one", file: one.file },
				{ id: "s-two", file: two.file, cwd: two.cwd },
			],
			{},
		);
		expect(result).toEqual({ removed: ["s-one", "s-two"], refused: [], failed: [] });
		for (const entry of [one, two])
			for (const target of [entry.file, ...entry.folders]) expect(fs.existsSync(target)).toBe(false);
		expect(index.get("s-one")).toBeUndefined();
		expect(index.get("s-two")).toBeUndefined();
	});

	it("refuses the current session and a running one, touching nothing", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const current = fixture("s-current");
		const live = fixture("s-live", process.pid);
		const result = await removeSessions(
			index,
			[
				{ id: "s-current", file: current.file },
				{ id: "s-live", file: live.file },
			],
			{ current: "s-current" },
		);
		expect(result.removed).toEqual([]);
		expect(result.refused).toEqual([
			{ id: "s-current", reason: "current" },
			{ id: "s-live", reason: "running" },
		]);
		expect(fs.existsSync(current.file)).toBe(true);
		expect(fs.existsSync(live.folders[0])).toBe(true);
		expect(index.get("s-live")).toBeDefined();
	});

	it("reports a bad target in failed and goes on with the others", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const good = fixture("s-good");
		const result = await removeSessions(index, [{ id: ".." }, { id: "s-good", file: good.file }], {});
		expect(result.removed).toEqual(["s-good"]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]?.id).toBe("..");
	});

	it("fails a session whose workspace marker no longer matches, removing nothing of it", async () => {
		const index = new SessionIndex(sharedAgentDb());
		const entry = fixture("s-moved");
		fs.rmSync(path.join(path.dirname(path.dirname(entry.file)), "workspace"), { recursive: true, force: true });
		const result = await removeSessions(index, [{ id: "s-moved", file: entry.file }], {});
		expect(result.removed).toEqual([]);
		expect(result.failed[0]?.error).toContain("workspace could not be verified");
		expect(fs.existsSync(entry.file)).toBe(true);
		expect(index.get("s-moved")).toBeDefined();
	});
});
