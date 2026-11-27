import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pollDescendants } from "../../src/octocode/shared/descendant-poller.ts";
import { resetPsSnapshot } from "../../src/octocode/shared/ps-snapshot.ts";

/** Every `ps` answers at once with an empty table, so only the poller's own timing decides how many run. */
const ps = vi.hoisted(() => ({ spawns: 0, block: false, waiting: [] as Array<() => void> }));
vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof ChildProcess>();
	return {
		...real,
		execFile: ((command: string, args: string[], options: unknown, done: (e: Error | null, out: string) => void) => {
			if (command !== "ps") return (real.execFile as (...a: unknown[]) => unknown)(command, args, options, done);
			ps.spawns++;
			if (ps.block) ps.waiting.push(() => done(null, ""));
			else queueMicrotask(() => done(null, ""));
			return undefined;
		}) as typeof real.execFile,
	};
});

beforeEach(() => {
	ps.spawns = 0;
	ps.block = false;
	ps.waiting = [];
	resetPsSnapshot();
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	resetPsSnapshot();
});

it.skipIf(process.platform === "win32")(
	"polls on the shared process table: about one ps per second, plus one fresh read at stop",
	async () => {
		const poller = pollDescendants(process.pid);
		await vi.advanceTimersByTimeAsync(2500);
		// Ticks at 0, 1.1 s and 2.2 s; the old 400 ms fresh poll spawned seven in this window.
		expect(ps.spawns).toBe(3);
		const before = ps.spawns;
		await poller.stop();
		// A decision needs a table read after it was asked for.
		expect(ps.spawns).toBe(before + 1);
	},
);

it.skipIf(process.platform === "win32")("coalesces hurry reads while a slow ps is still running", async () => {
	const poller = pollDescendants(process.pid);
	await vi.advanceTimersByTimeAsync(0);
	const before = ps.spawns;
	ps.block = true;
	poller.hurry();
	poller.hurry();
	await vi.advanceTimersByTimeAsync(1000);
	expect(ps.spawns).toBe(before + 1);
	ps.block = false;
	for (const done of ps.waiting.splice(0)) done();
	await vi.advanceTimersByTimeAsync(0);
	const stopping = poller.stop();
	await vi.advanceTimersByTimeAsync(0);
	await stopping;
});
