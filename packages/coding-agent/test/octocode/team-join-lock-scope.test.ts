import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import * as processes from "../../src/octocode/shared/process.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { tmp } from "./helpers.ts";

const member = (id: string, pid: number): Member => ({
	id,
	pid,
	started: String(pid),
	role: "worker",
	status: "idle",
	joinedAt: 1000,
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});
const stores: TeamStore[] = [];
function pair(): [TeamStore, TeamStore] {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const file = path.join(cwd, "team.sqlite");
	const a = TeamStore.open(cwd, file);
	const b = TeamStore.open(cwd, file);
	stores.push(a, b);
	return [a, b];
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const store of stores.splice(0)) store.close();
});

it("allows a second writer while checking the process holding a colliding name", () => {
	const [joining, peer] = pair();
	expect(peer.join(member("held", process.ppid))).toBe(true);
	const check = vi.spyOn(processes, "sameProcess").mockImplementation(() => {
		expect(peer.quick(() => peer.join(member("independent", process.pid)))).toBe(true);
		return true;
	});
	expect(joining.join(member("held", process.pid))).toBe(false);
	expect(check).toHaveBeenCalledOnce();
	expect(
		peer
			.list()
			.map((row) => row.id)
			.sort(),
	).toEqual(["held", "independent"]);
});

it.each(["pid", "started"] as const)(
	"rechecks a holder with changed %s before using the previous verdict",
	(changed) => {
		const [joining, peer] = pair();
		const old = member("held", changed === "pid" ? 2 ** 22 + 4242 : process.ppid);
		const replacement = { ...member("held", process.ppid), started: "new-generation" };
		expect(peer.join(old)).toBe(true);
		const check = vi
			.spyOn(processes, "sameProcess")
			.mockImplementationOnce(() => {
				expect(peer.quick(() => peer.remove(old.id, Date.now(), old))).toBe(true);
				expect(peer.quick(() => peer.join(replacement))).toBe(true);
				return false;
			})
			.mockReturnValue(true);
		expect(joining.join(member("held", process.pid))).toBe(false);
		expect(check).toHaveBeenCalledTimes(2);
		expect(peer.list()[0]).toMatchObject({ pid: replacement.pid, started: replacement.started });
	},
);

it("checks a child name outside the lease transaction and commits no leases on a live collision", () => {
	const [joining, peer] = pair();
	expect(peer.join(member("held", process.ppid))).toBe(true);
	const check = vi.spyOn(processes, "sameProcess").mockImplementation(() => {
		expect(peer.quick(() => peer.join(member("independent", process.pid)))).toBe(true);
		return true;
	});
	expect(() =>
		joining.lock(
			"held",
			[{ path: "child.ts", kind: "file", reason: "child edit" }],
			Date.now(),
			member("held", process.pid),
		),
	).toThrow("held by another running agent");
	expect(check).toHaveBeenCalledOnce();
	expect(peer.leases()).toEqual([]);
});
