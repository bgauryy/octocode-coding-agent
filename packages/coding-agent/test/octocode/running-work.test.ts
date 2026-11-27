import { describe, expect, it } from "vitest";
import { RunningWork } from "../../src/octocode/shared/running-work.ts";

describe("running work store", () => {
	it("counts background subagents, bash jobs and external work as busy, but not a timer that only waits", () => {
		const work = new RunningWork();
		expect(work.busy()).toBe(0);
		work.set("timer", [{ kind: "timer", id: "#1", title: "wake at 9" }]);
		expect(work.busy()).toBe(0);
		work.setBackground(["general-1a2b", "general-3c4d"]);
		work.set("bash", [{ kind: "bash", id: "bash-1", title: "build" }]);
		expect(work.busy()).toBe(3);
		expect(work.background()).toEqual(["general-1a2b", "general-3c4d"]);
		work.setBackground([]);
		work.set("bash", []);
		expect(work.busy()).toBe(0);
	});

	it("tells listeners only when the background list really changes", () => {
		const work = new RunningWork();
		let calls = 0;
		const stop = work.subscribe(() => calls++);
		work.setBackground(["a"]);
		work.setBackground(["a"]);
		expect(calls).toBe(1);
		work.setBackground([]);
		expect(calls).toBe(2);
		stop();
		work.setBackground(["b"]);
		expect(calls).toBe(2);
	});
});
