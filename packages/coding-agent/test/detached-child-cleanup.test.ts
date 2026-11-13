import { afterEach, describe, expect, it, vi } from "vitest";
import { killTrackedDetachedChildren, trackDetachedChildPid, untrackDetachedChildPid } from "../src/utils/shell.ts";

const pid = 456789;
afterEach(() => {
	untrackDetachedChildPid(pid);
	vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("detached child cleanup", () => {
	it("never falls back to a positive PID after the tracked group is gone", () => {
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error("No such process"), { code: "ESRCH" });
		});
		trackDetachedChildPid(pid);
		killTrackedDetachedChildren();
		expect(kill).toHaveBeenCalledExactlyOnceWith(-pid, "SIGKILL");
		kill.mockClear();
		killTrackedDetachedChildren();
		expect(kill).not.toHaveBeenCalled();
	});

	it("preserves graceful children until final cleanup", () => {
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		trackDetachedChildPid(pid, { graceful: true });
		killTrackedDetachedChildren({ sparingGraceful: true });
		expect(kill).not.toHaveBeenCalled();
		killTrackedDetachedChildren();
		expect(kill).toHaveBeenCalledExactlyOnceWith(-pid, "SIGKILL");
	});
});
