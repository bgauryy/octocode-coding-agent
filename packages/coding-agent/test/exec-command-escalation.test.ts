import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({
	group: true,
	track: vi.fn(),
	untrack: vi.fn(),
	spawn: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: shell.spawn }));
vi.mock("../src/utils/shell.ts", () => ({
	leadsProcessGroup: () => shell.group,
	trackDetachedChildPid: shell.track,
	untrackDetachedChildPid: shell.untrack,
}));
import { execCommand } from "../src/core/exec.ts";

describe("execCommand process-tree escalation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		shell.group = true;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function child() {
		const proc = Object.assign(new EventEmitter(), {
			pid: 456789,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			signalCode: null as NodeJS.Signals | null,
			kill: vi.fn(),
		});
		shell.spawn.mockReturnValue(proc);
		return proc;
	}

	it("forces remaining group members after their root exits on SIGTERM", async () => {
		const proc = child();
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		const controller = new AbortController();
		const running = execCommand("command", [], "/workspace", { signal: controller.signal });
		controller.abort();
		proc.signalCode = "SIGTERM";
		proc.emit("exit", null);
		await vi.advanceTimersByTimeAsync(100);
		expect((await running).killed).toBe(true);
		expect(signal).toHaveBeenCalledWith(-proc.pid, "SIGTERM");
		// An exited leader says nothing about descendants that ignored SIGTERM.
		expect(shell.untrack).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4900);
		expect(signal).toHaveBeenCalledWith(-proc.pid, "SIGKILL");
		expect(shell.untrack).toHaveBeenCalledExactlyOnceWith(proc.pid);
	});

	it("still escalates if the deadline arrives after the root exited", async () => {
		const proc = child();
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		const running = execCommand("command", [], "/workspace", { timeout: 50 });
		proc.emit("exit", 0);
		await vi.advanceTimersByTimeAsync(150);
		expect((await running).killed).toBe(true);
		await vi.advanceTimersByTimeAsync(4900);
		expect(signal).toHaveBeenCalledWith(-proc.pid, "SIGKILL");
		expect(shell.untrack).toHaveBeenCalledExactlyOnceWith(proc.pid);
	});

	it("does not signal an exited root on platforms without process groups", async () => {
		shell.group = false;
		const proc = child();
		const signal = vi.spyOn(process, "kill").mockReturnValue(true);
		const controller = new AbortController();
		const running = execCommand("command", [], "/workspace", { signal: controller.signal });
		controller.abort();
		proc.emit("exit", null);
		await vi.advanceTimersByTimeAsync(5100);
		await running;
		expect(proc.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
		expect(signal).not.toHaveBeenCalled();
	});
});
