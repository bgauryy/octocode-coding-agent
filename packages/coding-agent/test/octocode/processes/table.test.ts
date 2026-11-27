import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProcessTable } from "../../../src/octocode/processes/table.ts";
import {
	PS_CACHE_MS,
	parsePsTable,
	readPsSnapshot,
	resetPsSnapshot,
} from "../../../src/octocode/shared/ps-snapshot.ts";

/** What each mocked `ps -A` run does next: print a string, fail, or stay pending until released. */
const ps = vi.hoisted(() => ({
	spawns: 0,
	next: [] as Array<string | Error>,
	gate: undefined as Promise<void> | undefined,
}));
vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof ChildProcess>();
	return {
		...real,
		execFile: ((command: string, args: string[], options: unknown, done: (e: Error | null, out: string) => void) => {
			if (command !== "ps" || !args.includes("-A"))
				return (real.execFile as (...a: unknown[]) => unknown)(command, args, options, done);
			ps.spawns++;
			const result = ps.next.shift() ?? "";
			const finish = () => (result instanceof Error ? done(result, "") : done(null, result));
			if (ps.gate) void ps.gate.then(finish);
			else queueMicrotask(finish);
			return undefined;
		}) as typeof real.execFile,
	};
});

const LINE = (pid: number) => `${pid} 1 ${pid} Ss 1.5 2048 Tue Nov  3 20:13:00 2026 cmd-${pid} --flag`;

beforeEach(() => {
	ps.spawns = 0;
	ps.next.length = 0;
	ps.gate = undefined;
	resetPsSnapshot();
});
afterEach(() => {
	vi.useRealTimers();
	resetPsSnapshot();
});

describe("parsePsTable", () => {
	it("reads every column of a row, with the start time as UTC seconds", () => {
		const rows = parsePsTable(
			["    1     0     1 Ss    0.0   9000 Mon Jan  2 15:04:05 2006 /sbin/launchd", "garbage line", LINE(2147)].join(
				"\n",
			),
		);
		expect([...rows.keys()]).toEqual([1, 2147]);
		expect(rows.get(2147)).toEqual({
			pid: 2147,
			ppid: 1,
			pgid: 2147,
			stat: "Ss",
			cpu: 1.5,
			rssKb: 2048,
			started: String(Date.UTC(2026, 10, 3, 20, 13, 0) / 1000),
			command: "cmd-2147 --flag",
		});
	});

	it("keeps a row whose start time ps left blank, with started undefined", () => {
		const rows = parsePsTable("  200     1   200 S    0.0 100");
		expect(rows.get(200)?.started).toBeUndefined();
	});
});

describe("readPsSnapshot", () => {
	it("shares one spawn between callers in the same window, also while it is running", async () => {
		ps.next.push(LINE(10));
		let release!: () => void;
		ps.gate = new Promise<void>((resolve) => (release = resolve));
		const first = readPsSnapshot();
		const second = readPsSnapshot();
		release();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(await readPsSnapshot()).toBe(a);
		expect(ps.spawns).toBe(1);
		expect(a?.rows.has(10)).toBe(true);
	});

	it("reads again once the cache window has passed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		ps.next.push(LINE(10), LINE(11));
		await readPsSnapshot();
		vi.advanceTimersByTime(PS_CACHE_MS - 1);
		await readPsSnapshot();
		expect(ps.spawns).toBe(1);
		vi.advanceTimersByTime(1);
		const later = await readPsSnapshot();
		expect(ps.spawns).toBe(2);
		expect(later?.rows.has(11)).toBe(true);
	});

	it("rejects for every waiter when the read fails, and the next caller reads again", async () => {
		ps.next.push(new Error("ps timed out"), LINE(10));
		let release!: () => void;
		ps.gate = new Promise<void>((resolve) => (release = resolve));
		const waiters = [readPsSnapshot(), readPsSnapshot()].map((read) => expect(read).rejects.toThrow("ps timed out"));
		release();
		await Promise.all(waiters);
		ps.gate = undefined;
		expect((await readPsSnapshot())?.rows.has(10)).toBe(true);
		expect(ps.spawns).toBe(2);
	});
});

describe("readProcessTable", () => {
	it("lists processes with a start time and leaves out the ps that read the table", async () => {
		ps.next.push(
			[
				LINE(10),
				"  11 1 11 S 0.0 100",
				"  12 1 12 S 0.0 100 Tue Nov  3 20:13:00 2026 ps -A -o pid=,ppid=,pgid=,stat=,%cpu=,rss=,lstart=,command=",
			].join("\n"),
		);
		expect((await readProcessTable())?.map((row) => row.pid)).toEqual([10]);
	});

	it("is undefined, not empty, when ps fails", async () => {
		ps.next.push(new Error("no ps"));
		expect(await readProcessTable()).toBeUndefined();
	});
});
