import { describe, expect, it } from "vitest";
import type { Orphan } from "../../../src/octocode/processes/classify.ts";
import { stopOrphans } from "../../../src/octocode/processes/stop.ts";

const orphan = (pid: number, started: string | null, kind = "mcp"): Orphan => ({
	pid,
	started: started as string,
	kind,
	label: `child ${pid}`,
	rssKb: 1,
	ageMs: 1,
	ownerPid: 5,
	ownerLabel: "main-aaaaaaaa",
	reason: "owner-gone",
});

function harness(options: { fresh: Orphan[]; match?: Record<number, "same" | "other" | "unknown"> }) {
	const stopped: number[] = [];
	return {
		stopped,
		deps: {
			current: async () => options.fresh,
			match: async (pid: number) => options.match?.[pid] ?? "same",
			stop: async (pid: number) => void stopped.push(pid),
		},
	};
}

describe("stopOrphans", () => {
	it("stops an orphan that is still the recorded process and still an orphan", async () => {
		const { deps, stopped } = harness({ fresh: [orphan(10, "9100")] });
		const result = await stopOrphans([orphan(10, "9100")], deps);
		expect(stopped).toEqual([10]);
		expect(result).toEqual([{ pid: 10, label: "child 10", outcome: "stopped" }]);
	});

	it("refuses a process the records no longer name as an orphan (not started by Octocode, or its owner is back)", async () => {
		const { deps, stopped } = harness({ fresh: [] });
		const result = await stopOrphans([orphan(10, "9100")], deps);
		expect(stopped).toEqual([]);
		expect(result[0]).toMatchObject({ pid: 10, outcome: "skipped", why: "not an orphan any more" });
	});

	it("refuses a pid that now has a different start time (pid reuse)", async () => {
		const { deps, stopped } = harness({ fresh: [orphan(10, "9100")], match: { 10: "other" } });
		const result = await stopOrphans([orphan(10, "9100")], deps);
		expect(stopped).toEqual([]);
		expect(result[0]).toMatchObject({ outcome: "skipped", why: "the pid belongs to another process now" });
	});

	it("refuses when the fresh table names the pid with another start time", async () => {
		const { deps, stopped } = harness({ fresh: [orphan(10, "9777")] });
		const result = await stopOrphans([orphan(10, "9100")], deps);
		expect(stopped).toEqual([]);
		expect(result[0].outcome).toBe("skipped");
	});

	it("refuses when the start time cannot be verified or was never recorded", async () => {
		const unverified = harness({ fresh: [orphan(10, "9100")], match: { 10: "unknown" } });
		expect((await stopOrphans([orphan(10, "9100")], unverified.deps))[0]).toMatchObject({
			outcome: "skipped",
			why: "its start time could not be verified",
		});
		const unrecorded = harness({ fresh: [orphan(11, null)] });
		expect((await stopOrphans([orphan(11, null)], unrecorded.deps))[0].outcome).toBe("skipped");
		expect(unverified.stopped.concat(unrecorded.stopped)).toEqual([]);
	});

	it("never signals pid 1, this process or a non-positive pid", async () => {
		const { deps, stopped } = harness({ fresh: [orphan(1, "1"), orphan(process.pid, "1"), orphan(0, "1")] });
		const result = await stopOrphans([orphan(1, "1"), orphan(process.pid, "1"), orphan(0, "1")], deps);
		expect(stopped).toEqual([]);
		expect(result.every((entry) => entry.outcome === "skipped")).toBe(true);
	});

	it("reports a stop that throws and goes on with the rest", async () => {
		const stopped: number[] = [];
		const result = await stopOrphans([orphan(10, "1"), orphan(11, "2")], {
			current: async () => [orphan(10, "1"), orphan(11, "2")],
			match: async () => "same",
			stop: async (pid) => {
				if (pid === 10) throw new Error("denied");
				stopped.push(pid);
			},
		});
		expect(stopped).toEqual([11]);
		expect(result[0]).toMatchObject({ outcome: "failed", why: "denied" });
		expect(result[1].outcome).toBe("stopped");
	});
});
