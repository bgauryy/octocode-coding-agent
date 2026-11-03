import type * as ChildProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parentProcessGone } from "../../src/octocode/team/session/parent.ts";

const ps = vi.hoisted(() => ({ started: "Thu Nov 3 12:00:00 2026" as string | undefined }));
vi.mock("node:child_process", async (actual) => {
	const real = await actual<typeof ChildProcess>();
	return {
		...real,
		execFileSync: ((command: string, ...args: unknown[]) => {
			if (command === "ps") {
				if (!ps.started) throw new Error("ps unavailable");
				return ps.started;
			}
			return (real.execFileSync as (...values: unknown[]) => unknown)(command, ...args);
		}) as typeof real.execFileSync,
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	ps.started = "Thu Nov 3 12:00:00 2026";
});

describe("parent process identity through a launcher", () => {
	it("detects a reused pid from its start time and accepts the current process", () => {
		vi.spyOn(process, "ppid", "get").mockReturnValue(1);
		expect(parentProcessGone(`${process.pid} Thu Jan  1 00:00:00 1970`)).toBe(process.platform !== "win32");
		expect(parentProcessGone(`${process.pid} ${ps.started}`)).toBe(false);
		expect(parentProcessGone(String(process.pid))).toBe(false);
		expect(parentProcessGone("garbage")).toBe(false);
	});

	it("retains a live parent when its start time cannot be read", () => {
		vi.spyOn(process, "ppid", "get").mockReturnValue(1);
		ps.started = undefined;
		expect(parentProcessGone(`${process.pid} Wed Dec 31 00:00:00 1969`)).toBe(false);
	});
});
