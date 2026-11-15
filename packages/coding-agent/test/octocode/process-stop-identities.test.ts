import { afterEach, expect, it, vi } from "vitest";
import type * as ProcessTree from "../../src/utils/process-tree.ts";
import { stopTree } from "../../src/octocode/shared/process.ts";

const mocked = vi.hoisted(() => ({ table: vi.fn(), signal: vi.fn() }));
vi.mock("../../src/octocode/shared/process-table.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	readProcessTable: mocked.table,
}));
vi.mock("../../src/utils/process-tree.ts", async (original) => ({
	...(await original<typeof ProcessTree>()),
	signalTree: mocked.signal,
}));
afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

it.skipIf(process.platform === "win32").each(["123", "124", undefined])(
	"checks a discovered detached descendant's identity before escalation: %s",
	async (current) => {
		vi.spyOn(process, "kill").mockImplementation((pid) => {
			if (pid < 0) throw Object.assign(new Error("gone group"), { code: "ESRCH" });
			return true;
		});
		const row = { pid: 456, ppid: 123, pgid: 456, stat: "S", started: "123" };
		mocked.table
			.mockResolvedValueOnce({ at: 0, rows: new Map([[456, row]]) })
			.mockResolvedValue({ at: 1, rows: new Map([[456, { ...row, ppid: 1, started: current }]]) });
		await stopTree(123, 0);
		expect(mocked.signal.mock.calls).toEqual(
			current === "123"
				? [
						[123, "SIGTERM"],
						[456, "SIGKILL"],
					]
				: [[123, "SIGTERM"]],
		);
	},
);

it.skipIf(process.platform === "win32")(
	"does not signal a reused root or its new process group after the async recheck",
	async () => {
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		const root = { pid: 123, ppid: 1, pgid: 123, stat: "S", started: "123" };
		mocked.table
			.mockResolvedValueOnce({ at: 0, rows: new Map([[123, root]]) })
			.mockResolvedValue({ at: 1, rows: new Map([[123, { ...root, started: "124" }]]) });
		await stopTree(123, 0);
		expect(mocked.signal.mock.calls).toEqual([[123, "SIGTERM"]]);
		expect(kill.mock.calls.filter((call) => call[1] === "SIGKILL")).toEqual([]);
	},
);
