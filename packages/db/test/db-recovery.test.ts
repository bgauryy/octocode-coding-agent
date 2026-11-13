import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, sharedDatabase, closeSharedAgentDb, type AgentDb } from "../src/api.ts";

const roots: string[] = [];
const opened: AgentDb[] = [];
const locations = () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-db-recovery-"));
	roots.push(root);
	return {
		file: path.join(root, "agent.db"),
		mirrorFile: path.join(root, "agent.transcripts.db"),
		archiveDir: path.join(root, "archive"),
		privateParent: true,
	};
};
afterEach(() => {
	for (const db of opened.splice(0)) db.close();
	closeSharedAgentDb();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("database recovery", () => {
	it("releases the transaction when reading the event head fails, then rolls back the next failed write", () => {
		const agent = openDatabase(locations());
		opened.push(agent);
		agent.onEvents(() => {});
		agent.db.exec("ALTER TABLE agent_events RENAME TO saved_events");
		expect(() => agent.transaction(() => {})).toThrow();
		expect(agent.db.isTransaction).toBe(false);
		agent.db.exec("ALTER TABLE saved_events RENAME TO agent_events");
		expect(() =>
			agent.transaction(() => {
				agent.db.prepare("INSERT INTO meta(key,value) VALUES ('rollback-probe','value')").run();
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(agent.db.prepare("SELECT value FROM meta WHERE key='rollback-probe'").get()).toBeUndefined();
		expect(agent.transaction(() => 42)).toBe(42);
	});

	it("reopens a shared connection after its owner closes it", () => {
		const target = locations();
		const first = sharedDatabase(target);
		first.close();
		const next = sharedDatabase(target);
		expect(next.db.isOpen).toBe(true);
		expect(next === first).toBe(false);
		expect(next.transaction(() => 42)).toBe(42);
	});

	it("does not create a lazy mirror after its owning database closes", () => {
		const target = locations();
		const agent = openDatabase(target);
		opened.push(agent);
		agent.close();
		expect(() => agent.mirror).toThrow(/closed/i);
		expect(fs.existsSync(target.mirrorFile)).toBe(false);
	});

	it("does not reopen a previously used mirror after its owning database closes", () => {
		const agent = openDatabase(locations());
		opened.push(agent);
		const mirror = agent.mirror.db;
		agent.close();
		expect(mirror.isOpen).toBe(false);
		expect(() => agent.mirror).toThrow(/closed/i);
	});
});
