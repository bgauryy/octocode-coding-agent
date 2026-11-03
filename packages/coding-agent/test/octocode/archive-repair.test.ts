import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registeredWorkspace } from "../../src/config/workspace-database.ts";
import { openAgentDb } from "../../src/config/database.ts";
import { compactions } from "../../../db/src/api.ts";
import { HistoryRepair } from "../../src/octocode/archive/repair.ts";
import { tmp } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

it("parses shared ancestors once per recovery batch and observes new entries in a later batch", async () => {
	const root = tmp();
	const db = openAgentDb(path.join(root, "agent.db"));
	registeredWorkspace(root, db);
	const env = { OCTOCODE_HOME: path.join(root, "home") };
	const parent = path.join(root, "parent.jsonl");
	const header = { type: "session", version: 3, id: "parent", cwd: root, timestamp: "2026-01-01T00:00:00Z" };
	const entry = {
		type: "compaction",
		id: "first",
		parentId: null,
		timestamp: header.timestamp,
		summary: "original decision",
		firstKeptEntryId: "kept",
		tokensBefore: 100,
	};
	const write = (file: string, rows: object[]) =>
		fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	write(parent, [header, entry]);
	const forks = Array.from({ length: 3 }, (_, i) => {
		const file = path.join(root, `fork-${i}.jsonl`);
		write(file, [{ ...header, id: `fork-${i}`, parentSession: parent }, entry]);
		return file;
	});
	try {
		const opened = vi.spyOn(fs, "createReadStream");
		const repair = new HistoryRepair(db, env);
		for (const file of forks) await repair.transcript(file);
		expect(opened).toHaveBeenCalledTimes(4);
		expect(compactions.forSession(db.db, "parent")).toHaveLength(1);
		for (let i = 0; i < 3; i++) expect(compactions.forSession(db.db, `fork-${i}`)).toHaveLength(0);
		write(parent, [header, entry, { ...entry, id: "second", summary: "new decision" }]);
		await new HistoryRepair(db, env).transcript(forks[0]);
		expect(compactions.forSession(db.db, "parent")).toHaveLength(2);
		const stop = new AbortController();
		stop.abort();
		await expect(new HistoryRepair(db, env, stop.signal).transcript(parent)).rejects.toThrow();
		expect(opened).toHaveBeenCalledTimes(6);
	} finally {
		db.close();
	}
});
