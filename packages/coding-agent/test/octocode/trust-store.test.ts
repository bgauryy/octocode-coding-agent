import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { trust, type AgentDb } from "../../../db/src/api.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { tmp } from "./helpers.ts";

let file: string;
let agent: AgentDb;
beforeEach(() => {
	file = path.join(tmp(), "trust.db");
	agent = openAgentDb(file);
});
afterEach(() => agent.close());

const input = (ino: string, extra: Partial<trust.FolderDecisionInput> = {}): trust.FolderDecisionInput => ({
	path: `/p/${ino}`,
	dev: "1",
	ino,
	birth: "0",
	decision: "trusted",
	scope: "folder",
	source: "prompt",
	surface: "tui",
	decidedBy: "ada",
	...extra,
});

describe("trusted_folders queries", () => {
	it("stores provenance and reads back exact 64-bit identities", () => {
		const big = "18446744073709551615";
		const { id, created } = trust.decide(agent.db, input(big, { fromPath: "/src", birth: "1730000000123456789" }), 5);
		expect(created).toBe(true);
		expect(trust.liveAt(agent.db, "1", big)).toEqual({
			id,
			path: `/p/${big}`,
			dev: "1",
			ino: big,
			birth: "1730000000123456789",
			decision: "trusted",
			scope: "folder",
			source: "prompt",
			surface: "tui",
			decidedBy: "ada",
			decidedAt: 5,
			fromPath: "/src",
		});
	});

	it("finds the live rows of several folders in one call and leaves others out", () => {
		for (const ino of ["1", "2", "3"]) trust.decide(agent.db, input(ino), 1);
		const found = trust.liveFoldersFor(agent.db, [
			{ dev: "1", ino: "1" },
			{ dev: "1", ino: "3" },
			{ dev: "2", ino: "2" },
		]);
		expect(found.map((row) => row.ino).sort()).toEqual(["1", "3"]);
		expect(trust.liveFoldersFor(agent.db, [])).toEqual([]);
	});

	it("supersedes a different decision and ignores an identical one", () => {
		const first = trust.decide(agent.db, input("1"), 1);
		expect(trust.decide(agent.db, input("1", { source: "command" }), 2)).toEqual({ id: first.id, created: false });
		const refused = trust.decide(agent.db, input("1", { decision: "refused" }), 3);
		expect(refused.created).toBe(true);
		expect(trust.liveAt(agent.db, "1", "1")).toMatchObject({ id: refused.id, decision: "refused" });
		expect(trust.list(agent.db).map((row) => [row.id, row.revokedBy ?? null])).toEqual([
			[refused.id, null],
			[first.id, "superseded"],
		]);
	});

	it("refuses a second live row for one folder at the database level", () => {
		trust.decide(agent.db, input("1"), 1);
		const insert = () =>
			agent.db
				.prepare(
					"INSERT INTO trusted_folders (path, dev, ino, scope, source, surface, decided_by, decided_at) VALUES ('/x', '1', '1', 'subtree', 's', 's', 'u', 1)",
				)
				.run();
		expect(insert).toThrow(/UNIQUE/);
		trust.revoke(agent.db, 1, 2, "ada");
		expect(insert).not.toThrow();
	});

	it("rejects a decision or scope outside the two the resolver knows", () => {
		const insert = (decision: string, scope: string) => () =>
			agent.db
				.prepare(
					"INSERT INTO trusted_folders (path, dev, ino, decision, scope, source, surface, decided_by, decided_at) VALUES ('/x', '9', '9', ?, ?, 's', 's', 'u', 1)",
				)
				.run(decision, scope);
		expect(insert("maybe", "folder")).toThrow(/CHECK/);
		expect(insert("trusted", "everything")).toThrow(/CHECK/);
	});

	it("revokes only live rows and refreshes where a folder was seen", () => {
		const { id } = trust.decide(agent.db, input("1"), 1);
		trust.refreshSeen(agent.db, id, "/moved", "1");
		expect(trust.liveAt(agent.db, "1", "1")?.path).toBe("/moved");
		expect(trust.revoke(agent.db, id, 2, "ada")).toBe(true);
		expect(trust.revoke(agent.db, id, 3, "bob")).toBe(false);
		expect(trust.list(agent.db)[0]).toMatchObject({ revokedAt: 2, revokedBy: "ada" });
	});

	it("keeps one row for a folder whose device number changed after a remount", () => {
		const birth = "1730000000123456789";
		const first = trust.decide(agent.db, input("7", { birth }), 1);
		// macOS numbers a volume at mount time: after a reboot the same folder reports another device.
		const seen = input("7", { birth, dev: "2" });
		const [candidate] = trust.liveFoldersFor(agent.db, [seen]);
		expect(trust.sameFolder(candidate, seen)).toBe("remounted");
		expect(trust.sameFolder(candidate, { ...seen, path: "/elsewhere" })).toBeUndefined();
		expect(trust.sameFolder(candidate, { ...seen, birth: "1" })).toBeUndefined();
		// The same decision again is a no-op that stores the new device; a different one supersedes the remounted row.
		expect(trust.decide(agent.db, seen, 2)).toEqual({ id: first.id, created: false });
		expect(trust.liveAt(agent.db, "2", "7")?.id).toBe(first.id);
		const refused = trust.decide(agent.db, input("7", { birth, dev: "3", decision: "refused" }), 3);
		expect(refused.created).toBe(true);
		expect(
			trust
				.list(agent.db)
				.filter((row) => row.revokedAt === undefined)
				.map((row) => row.id),
		).toEqual([refused.id]);
	});

	it("does not treat a row on another device as the folder without a recorded birth time", () => {
		trust.decide(agent.db, input("7"), 1);
		expect(trust.liveFoldersFor(agent.db, [input("7", { dev: "2" })])).toEqual([]);
	});

	it("revokes by source and path or identity, and nothing else", () => {
		trust.decide(agent.db, input("1", { source: "worktree", path: "/wt/a" }), 1);
		trust.decide(agent.db, input("2", { source: "worktree", path: "/wt/b" }), 1);
		trust.decide(agent.db, input("3", { source: "prompt", path: "/wt/a2" }), 1);
		expect(trust.revokeBySource(agent.db, "worktree", { path: "/wt/a" }, 2, "u")).toBe(1);
		expect(
			trust.revokeBySource(agent.db, "worktree", { path: "/else", identity: { dev: "1", ino: "2" } }, 2, "u"),
		).toBe(1);
		expect(
			trust.revokeBySource(agent.db, "worktree", { path: "/wt/a2", identity: { dev: "1", ino: "3" } }, 2, "u"),
		).toBe(0);
		expect(trust.liveAt(agent.db, "1", "3")).toBeDefined();
	});
});
