import type * as ChildProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pollDescendants } from "../../src/octocode/shared/descendant-poller.ts";
import { resetPsSnapshot } from "../../src/octocode/shared/ps-snapshot.ts";

/** Every `ps` answers at once with an empty table, so only the poller's own timing decides how many run. */
const ps = vi.hoisted(() => ({ spawns: 0 }));
vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof ChildProcess>();
	return {
		...real,
		execFile: ((command: string, args: string[], options: unknown, done: (e: Error | null, out: string) => void) => {
			if (command !== "ps") return (real.execFile as (...a: unknown[]) => unknown)(command, args, options, done);
			ps.spawns++;
			queueMicrotask(() => done(null, ""));
			return undefined;
		}) as typeof real.execFile,
	};
});

beforeEach(() => {
	ps.spawns = 0;
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
