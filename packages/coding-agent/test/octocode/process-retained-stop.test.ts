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

it.skipIf(process.platform === "win32").each([
	{ current: "123", recorded: "123", allowed: true },
	{ current: "124", recorded: "123", allowed: false },
	{ current: undefined, recorded: "123", allowed: false },
	{ current: "123", recorded: undefined, allowed: false },
])(
	"signals a retained orphan only with the same known start identity: $current/$recorded",
	async ({ current, recorded, allowed }) => {
		vi.spyOn(process, "kill").mockImplementation((pid) => {
			if (pid < 0) throw Object.assign(new Error("gone group"), { code: "ESRCH" });
			return true;
		});
		mocked.table.mockResolvedValue({
			at: Date.now(),
			rows: new Map([[456, { pid: 456, ppid: 1, pgid: 456, stat: "S", started: current }]]),
		});
		await stopTree(123, 0, [{ pid: 456, ppid: 123, pgid: 456, stat: "S", started: recorded }]);
		expect(mocked.signal.mock.calls).toEqual(
			allowed
				? [
						[123, "SIGTERM"],
						[456, "SIGKILL"],
					]
				: [[123, "SIGTERM"]],
		);
	},
);
