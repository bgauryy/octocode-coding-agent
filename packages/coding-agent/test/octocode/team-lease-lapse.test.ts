import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { refreshProcessTable } from "../../src/octocode/shared/process-table.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";

/**
 * A reservation must survive a peer's conflict check while its owner runs and heartbeats. Peers retired live owners as
 * "crashed" when one process-table read disagreed with the start time a row recorded (B551), which deleted the owner's
 * leases and made its next edit fail with "Your reservation ... lapsed".
 */

const member = (id: string, extra: Partial<Member> = {}): Member => ({
	id,
	role: "worker",
	pid: process.ppid,
	// Not this process's real start time: a table read judges the pid a different process.
	started: "1",
	status: "working",
	joinedAt: 1_000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
	...extra,
});
const request = (file: string) => [{ path: file, kind: "file" as const, reason: "edit" }];

const stores: TeamStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function pair(env: NodeJS.ProcessEnv = {}) {
	const cwd = fs.realpathSync(tmp());
	fs.mkdirSync(path.join(cwd, ".git"));
	const file = path.join(tmp(), "team.sqlite");
	const open = () => {
		const store = TeamStore.open(cwd, file, env);
		stores.push(store);
		return store;
	};
	return { cwd, owner: open(), peer: open() };
}

describe("a peer's conflict check", () => {
	it("keeps the leases of a running owner with a fresh heartbeat, whatever the table says of its start time", async () => {
		const { cwd, owner, peer } = pair();
		const held = path.join(cwd, "src/a.ts");
		expect(owner.join(member("owner"))).toBe(true);
		expect(owner.lock("owner", request(held)).ok).toBe(true);
		await refreshProcessTable();

		expect(peer.conflict(held, "peer")?.owner).toBe("owner");
		expect([...owner.owned("owner")]).toEqual(["file:/src/a.ts"]);
		expect(peer.list().map((row) => row.id)).toContain("owner");
	});

	it("still frees the leases of an owner whose heartbeat stopped and whose pid is another process", async () => {
		const { cwd, owner, peer } = pair();
		const held = path.join(cwd, "src/a.ts");
		owner.join(member("owner", { updatedAt: Date.now() - 5 * 60_000 }));
		owner.lock("owner", request(held));
		await refreshProcessTable();

		expect(peer.conflict(held, "peer")).toBeUndefined();
		expect(owner.owned("owner").size).toBe(0);
	});

	it("keeps what a settled child holds for its parent", async () => {
		const { cwd, owner, peer } = pair();
		const held = path.join(cwd, "src/a.ts");
		owner.join(member("child", { pid: process.pid, started: undefined }));
		owner.lock("child", request(held));
		expect(owner.settle("child", { pid: process.pid }, { pid: process.ppid, started: "1" })).toBe(true);
		await refreshProcessTable();

		expect(peer.conflict(held, "peer")?.owner).toBe("child");
	});

	it("reads a child's leases back from the checkout its parent chose", () => {
		const { cwd } = pair();
		const sub = path.join(cwd, "packages/x");
		fs.mkdirSync(sub, { recursive: true });
		const file = path.join(tmp(), "child.sqlite");
		const env = { OCTOCODE_TEAM_WORKSPACE: cwd };
		const child = TeamStore.open(sub, file, env);
		stores.push(child);
		child.join(member("child", { pid: process.pid, started: undefined }));
		expect(child.lock("child", request(path.join(sub, "b.ts"))).ok).toBe(true);
		expect([...child.owned("child")]).toEqual(["file:/packages/x/b.ts"]);
	});
});
