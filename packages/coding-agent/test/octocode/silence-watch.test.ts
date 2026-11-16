import { describe, expect, it } from "vitest";
import { SilenceWatch } from "../../src/octocode/team/silence-watch.ts";

const MIN = 60_000;
const T = 10 * MIN;

describe("SilenceWatch", () => {
	it("is due only once the child has been silent for the threshold", () => {
		const watch = new SilenceWatch();
		const child = [{ id: "a", lastOutputAt: 0 }];
		expect(watch.due(child, T, T - 1)).toEqual([]);
		expect(watch.due(child, T, T)).toEqual(["a"]);
	});

	it("backs off to 2x and 4x, then stops", () => {
		const watch = new SilenceWatch();
		const child = [{ id: "a", lastOutputAt: 0 }];
		const toldAt: number[] = [];
		for (let now = 0; now <= 100 * MIN; now += MIN)
			if (watch.due(child, T, now).length) {
				toldAt.push(now / MIN);
				watch.told("a");
			}
		expect(toldAt).toEqual([10, 20, 40]);
	});

	it("starts a new episode on progress", () => {
		const watch = new SilenceWatch();
		watch.due([{ id: "a", lastOutputAt: 0 }], T, T);
		watch.told("a");
		expect(watch.due([{ id: "a", lastOutputAt: 15 * MIN }], T, 20 * MIN)).toEqual([]);
		expect(watch.due([{ id: "a", lastOutputAt: 15 * MIN }], T, 25 * MIN)).toEqual(["a"]);
	});

	it("rechecks an excused child a minute later, not every tick", () => {
		const watch = new SilenceWatch();
		const child = [{ id: "a", lastOutputAt: 0 }];
		watch.due(child, T, T);
		watch.excused("a", T);
		expect(watch.due(child, T, T + 30_000)).toEqual([]);
		expect(watch.due(child, T, T + MIN)).toEqual(["a"]);
	});

	it("ignores children with no progress yet, and is off at 0", () => {
		const watch = new SilenceWatch();
		expect(watch.due([{ id: "a", lastOutputAt: undefined }], T, 99 * MIN)).toEqual([]);
		expect(watch.due([{ id: "b", lastOutputAt: 0 }], 0, 99 * MIN)).toEqual([]);
	});
});
