import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { closeSharedAgentDb, leases } from "../../../db/src/api.ts";
import { keptStatement } from "../../../db/src/statements.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";

/**
 * A lease check runs on every tool call. With no other owner's live lease anywhere it answers at once (no path is
 * resolved, no checkout listed); with one, it answers as before. The hot queries keep their prepared statement per
 * connection.
 */
const member = (id: string): Member => ({
	id,
	role: "main",
	pid: process.pid,
	status: "idle",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

const stores: TeamStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	closeSharedAgentDb();
});

function team() {
	const root = fs.realpathSync(tmp());
	const cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	const store = TeamStore.open(cwd, path.join(root, "team.sqlite"), {});
	stores.push(store);
	store.join(member("main-aaaaaa"));
	store.join(member("helper-bbbbbb"));
	return store;
}

const lock = (store: TeamStore, owner: string, file: string) =>
	store.lock(owner, [{ path: file, kind: "file", reason: "edit" }]).ok;

describe("lease conflicts with the no-lease shortcut", () => {
	it("finds no conflict without leases, nor with only the asker's own", () => {
		const store = team();
		expect(store.conflict("src/a.ts", "helper-bbbbbb")).toBeUndefined();
		expect(lock(store, "helper-bbbbbb", "src/a.ts")).toBe(true);
		expect(store.conflict("src/a.ts", "helper-bbbbbb")).toBeUndefined();
	});

	it("finds another owner's live lease, also through a tree above the file", () => {
		const store = team();
		expect(lock(store, "main-aaaaaa", "src/a.ts")).toBe(true);
		expect(store.conflict("src/a.ts", "helper-bbbbbb")?.owner).toBe("main-aaaaaa");
		expect(store.conflict("src/b.ts", "helper-bbbbbb")).toBeUndefined();
		expect(store.lock("main-aaaaaa", [{ path: "lib", kind: "tree", reason: "move" }]).ok).toBe(true);
		expect(store.conflict("lib/deep/x.ts", "helper-bbbbbb")?.owner).toBe("main-aaaaaa");
	});

	it("ignores a lease once it has expired", () => {
		const store = team();
		expect(lock(store, "main-aaaaaa", "src/a.ts")).toBe(true);
		const later = Date.now() + 365 * 24 * 60 * 60 * 1000;
		expect(store.conflict("src/a.ts", "helper-bbbbbb", "file", later)).toBeUndefined();
	});
});

describe("leases.anyLiveOfOthers", () => {
	it("is true only for an unexpired lease of another owner", () => {
		const store = team();
		const db = (store as unknown as { db: Parameters<typeof leases.anyLiveOfOthers>[0] }).db;
		const now = Date.now();
		expect(leases.anyLiveOfOthers(db, "helper-bbbbbb", now)).toBe(false);
		expect(lock(store, "main-aaaaaa", "src/a.ts")).toBe(true);
		expect(leases.anyLiveOfOthers(db, "main-aaaaaa", now)).toBe(false);
		expect(leases.anyLiveOfOthers(db, "helper-bbbbbb", now)).toBe(true);
		expect(leases.anyLiveOfOthers(db, "helper-bbbbbb", now + 365 * 24 * 60 * 60 * 1000)).toBe(false);
	});
});

describe("keptStatement", () => {
	it("keeps one statement per connection and SQL text", () => {
		const first = openAgentDb(path.join(tmp(), "a.db"));
		const second = openAgentDb(path.join(tmp(), "b.db"));
		try {
			const sql = "SELECT key FROM meta WHERE key = ?";
			expect(keptStatement(first.db, sql)).toBe(keptStatement(first.db, sql));
			expect(keptStatement(second.db, sql)).not.toBe(keptStatement(first.db, sql));
			first.db.exec("INSERT INTO meta (key, value) VALUES ('kept-probe', '1')");
			expect(keptStatement(first.db, sql).get("kept-probe")).toEqual({ key: "kept-probe" });
			expect(keptStatement(second.db, sql).get("kept-probe")).toBeUndefined();
		} finally {
			first.close();
			second.close();
		}
	});
});
