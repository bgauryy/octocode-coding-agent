import type * as importedModule1 from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as importedModule2 from "../../src/octocode/shared/process.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import * as importedModule3 from "../../src/octocode/team/store.ts";
import * as importedModule4 from "../../src/octocode/shared/process-table.ts";
import { tmp } from "./helpers.ts";

/** `calls`: `ps` run on the calling thread (`execFileSync`); `async`: `ps` run without blocking (`execFile`). */
const ps = vi.hoisted(() => ({ calls: 0, async: 0 }));
vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof importedModule1>();
	return {
		...real,
		execFileSync: ((command: string, ...rest: unknown[]) => {
			if (command === "ps") ps.calls++;
			return (real.execFileSync as (...args: unknown[]) => unknown)(command, ...rest);
		}) as typeof real.execFileSync,
		execFile: ((command: string, ...rest: unknown[]) => {
			if (command === "ps") ps.async++;
			return (real.execFile as (...args: unknown[]) => unknown)(command, ...rest);
		}) as typeof real.execFile,
	};
});
const {
	killTree,
	liveProcess,
	processAlive,
	processMatch,
	processStartTime,
	processStartTimeAsync,
	sameProcess,
	sameProcessAsync,
	VERDICT_TTL_MS,
} = await Promise.resolve(importedModule2);
const { TeamStore } = await Promise.resolve(importedModule3);
const { refreshProcessTable, resetProcessTable } = await Promise.resolve(importedModule4);

const children: ChildProcess[] = [];
/** A live process other than this one, with the start time a row would record for it. */
async function peer(): Promise<{ pid: number; started: string }> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	children.push(child);
	const pid = child.pid!;
	const started = processStartTime(pid);
	if (started === undefined) throw new Error("ps cannot read the start time here");
	return { pid, started };
}
afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	resetProcessTable();
});

const member = (id: string, who: { pid: number; started: string }): Member => ({
	id,
	role: "reviewer",
	pid: who.pid,
	started: who.started,
	status: "working",
	joinedAt: Date.now(),
	updatedAt: Date.now(),
	toolCalls: 0,
	input: 0,
	cacheRead: 0,
	output: 0,
	cost: 0,
	unpriced: false,
});

describe("sameProcess is one memoized judgement", () => {
	it("shares async checks across concurrent cleanup callers without synchronous ps", async () => {
		const who = await peer();
		resetProcessTable();
		ps.calls = 0;
		ps.async = 0;
		const results = await Promise.all(Array.from({ length: 50 }, () => sameProcessAsync(who.pid, who.started)));
		expect(results.every(Boolean)).toBe(true);
		expect(ps.calls).toBe(0);
		expect(ps.async).toBe(1);
	});

	it("shares in-flight start-time reads and releases them after completion", async () => {
		const who = await peer();
		ps.calls = 0;
		ps.async = 0;
		const results = await Promise.all(Array.from({ length: 20 }, () => processStartTimeAsync(who.pid)));
		expect(results).toEqual(Array(20).fill(who.started));
		expect(ps.calls).toBe(0);
		expect(ps.async).toBe(1);
		await processStartTimeAsync(who.pid);
		expect(ps.async).toBe(2);
	});
	it("compares a live pid's start time once per TTL, whoever asks", async () => {
		const who = await peer();
		const t0 = 1_000_000_000_000;
		ps.calls = 0;
		for (let i = 0; i < 20; i++) expect(sameProcess(who.pid, who.started, t0 + i)).toBe(true);
		expect(ps.calls).toBe(1);
		expect(sameProcess(who.pid, who.started, t0 + VERDICT_TTL_MS - 1)).toBe(true);
		expect(ps.calls).toBe(1);
		expect(sameProcess(who.pid, who.started, t0 + VERDICT_TTL_MS)).toBe(true);
		expect(ps.calls).toBe(2);
	});

	it("remembers a different start time (a reused pid) as gone, and keeps each recorded start apart", async () => {
		const who = await peer();
		const t0 = 2_000_000_000_000;
		ps.calls = 0;
		const other = String(Number(who.started) - 5);
		expect(sameProcess(who.pid, other, t0)).toBe(false);
		expect(sameProcess(who.pid, other, t0 + 1)).toBe(false);
		expect(sameProcess(who.pid, who.started, t0 + 2)).toBe(true);
		expect(ps.calls).toBe(2);
	});

	it("judges a dead pid, or one with no recorded start time, without `ps`", async () => {
		const who = await peer();
		ps.calls = 0;
		expect(sameProcess(who.pid, undefined)).toBe(true);
		expect(sameProcess(who.pid, null)).toBe(true);
		expect(sameProcess(0, "1")).toBe(false);
		expect(sameProcess(2 ** 22 + 12345, "1")).toBe(false);
		expect(ps.calls).toBe(0);
	});

	it("sees a process die at once even while its verdict is remembered", async () => {
		const who = await peer();
		const t0 = 3_000_000_000_000;
		expect(sameProcess(who.pid, who.started, t0)).toBe(true);
		const child = children.at(-1)!;
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill("SIGKILL");
		await exited;
		expect(sameProcess(who.pid, who.started, t0 + 1)).toBe(false);
	});

	it("leaves processMatch fresh: before a signal the comparison is never reused, and never blocks", async () => {
		const who = await peer();
		ps.calls = 0;
		ps.async = 0;
		expect(await processMatch(who.pid, who.started)).toBe("same");
		expect(await processMatch(who.pid, who.started)).toBe("same");
		expect(await processMatch(who.pid, String(Number(who.started) - 5))).toBe("other");
		expect(ps.async).toBe(3);
		expect(ps.calls).toBe(0);
	});

	it("answers liveness on a timer without running ps on the calling thread: one asynchronous ps -A serves every caller", async () => {
		const who = await peer();
		resetProcessTable();
		ps.calls = 0;
		ps.async = 0;
		// Nothing known yet: alive counts, and one table read is asked for, however many callers ask.
		for (let i = 0; i < 20; i++) expect(liveProcess(who.pid, who.started)).toBe(true);
		expect(ps.calls).toBe(0);
		expect(ps.async).toBe(1);
		await refreshProcessTable();
		expect(ps.async).toBe(1);
		// The table now judges: a reused pid is gone, the real process is not, and neither asks `ps` again.
		expect(liveProcess(who.pid, String(Number(who.started) - 5))).toBe(false);
		expect(liveProcess(who.pid, who.started)).toBe(true);
		// The one-off `sameProcess` answers from the same table.
		expect(sameProcess(who.pid, String(Number(who.started) - 5))).toBe(false);
		expect(sameProcess(who.pid, who.started)).toBe(true);
		expect(ps.calls).toBe(0);
		expect(ps.async).toBe(1);
		// A table older than the TTL asks for a new one before it vouches for a process again (alive counts meanwhile);
		// a reused pid it saw stays gone without asking.
		expect(liveProcess(who.pid, String(Number(who.started) - 5), Date.now() + VERDICT_TTL_MS)).toBe(false);
		expect(ps.async).toBe(1);
		expect(liveProcess(who.pid, who.started, Date.now() + VERDICT_TTL_MS)).toBe(true);
		expect(ps.async).toBe(2);
		await refreshProcessTable();
		expect(ps.calls).toBe(0);
	});

	it("never runs ps on the calling thread for the team's sweep, list and lease-owner check", async () => {
		const who = await peer();
		const store = TeamStore.open(tmp(), path.join(tmp(), "team.sqlite"));
		try {
			const now = Date.now();
			store.save(member("owner", who));
			store.save(member("asker", { pid: process.pid, started: processStartTime(process.pid)! }));
			const file = path.join(store.workspace, "src", "a.ts");
			expect(store.lock("owner", [{ path: file, kind: "file", reason: "edit" }], now).ok).toBe(true);
			resetProcessTable();
			ps.calls = 0;
			// The sweep and the list run every second: they judge from the shared table and never call `ps` themselves.
			store.sweep(now);
			expect(store.list(now).map((row) => row.id)).toContain("owner");
			expect(ps.calls).toBe(0);
			await refreshProcessTable();
			expect(store.conflict(file, "asker", "file", Date.now())?.owner).toBe("owner");
			expect(ps.calls).toBe(0);
		} finally {
			store.close();
		}
	});

	it("lists a tree's descendants without blocking before it signals the tree", async () => {
		const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
		children.push(child);
		const exited = new Promise((resolve) => child.once("exit", resolve));
		await new Promise((resolve) => setTimeout(resolve, 100));
		ps.calls = 0;
		ps.async = 0;
		killTree(child.pid, 50);
		expect(processAlive(child.pid)).toBe(true);
		await exited;
		expect(ps.calls).toBe(0);
		expect(ps.async).toBe(1);
	});
});
