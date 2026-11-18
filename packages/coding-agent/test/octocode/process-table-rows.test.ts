import type * as ChildProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveProcess } from "../../src/octocode/shared/process.ts";
import { refreshProcessTable, readProcessTable, resetProcessTable } from "../../src/octocode/shared/process-table.ts";

/** What the mocked `ps -A` prints, or an error for a failed run. */
const ps = vi.hoisted(() => ({ outputs: [] as Array<string | Error> }));
vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof ChildProcess>();
	return {
		...real,
		execFile: ((command: string, args: string[], options: unknown, done: (e: Error | null, out: string) => void) => {
			if (command !== "ps" || !args.includes("-A"))
				return (real.execFile as (...a: unknown[]) => unknown)(command, args, options, done);
			const next = ps.outputs.shift() ?? "";
			queueMicrotask(() => (next instanceof Error ? done(next, "") : done(null, next)));
			return undefined;
		}) as typeof real.execFile,
	};
});

afterEach(() => {
	ps.outputs.length = 0;
	resetProcessTable();
});

const row = (pid: number, stat: string, lstart: string) => `${String(pid).padStart(6)} 1 ${pid} ${stat} ${lstart}`;
const LSTART = "Mon Nov 16 14:38:23 2026";

describe("the shared process table", () => {
	it("keeps a process whose start time ps left blank, so the table never calls it gone", async () => {
		// A line that ends after the state (no start time) once failed the row pattern and vanished from the table.
		ps.outputs.push([row(100, "Ss", LSTART), "   200     1   200 S", row(300, "S", LSTART)].join("\n"));
		const table = await readProcessTable();
		expect([...table!.rows.keys()].sort((a, b) => a - b)).toEqual([100, 200, 300]);
		expect(table!.rows.get(200)?.started).toBeUndefined();
	});

	it("does not retire a process that the table lists without a start time (its verdict is unknown, not gone)", async () => {
		const started = String(Date.UTC(2026, 10, 16, 14, 38, 23) / 1000);
		// This process is alive for `processAlive`, so only the table could call it gone.
		const pid = process.pid;
		ps.outputs.push([row(100, "Ss", LSTART), `${String(pid).padStart(6)}     1 ${pid} S`].join("\n"));
		await refreshProcessTable();
		expect(liveProcess(pid, started, Date.now(), false)).toBe(true);
	});

	it("keeps the earlier table when a later ps run fails", async () => {
		ps.outputs.push(row(100, "Ss", LSTART), new Error("ps timed out"));
		const first = await refreshProcessTable();
		const second = await refreshProcessTable();
		expect(second).toBe(first);
		expect(second?.rows.has(100)).toBe(true);
	});
});
