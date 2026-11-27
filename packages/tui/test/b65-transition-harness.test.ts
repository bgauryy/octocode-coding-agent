import assert from "node:assert";
import { describe, it } from "node:test";
import { createHarness, firstScreenDifference, type FrameSample } from "./b65-harness.ts";
import { runCold, runScript, TRANSITIONS } from "./b65-scenarios.ts";

/**
 * Drives the fullscreen transcript through its transitions with real assistant Markdown and records, for every frame,
 * whether the scroll view laid out virtually (rows in view first) or exactly. The virtual transcript must paint the
 * same screen as an exact one after each transition. Numbers: `.octocode/tmp/b65/measure.ts`.
 */
const SIZES = [1000, 10000];

describe("scroll view transitions: virtual or exact path, and the same screen", () => {
	for (const rows of SIZES) {
		it(`${rows} Markdown rows`, async () => {
			const virtual = createHarness({ rows, virtualize: true, markdown: true });
			const exact = createHarness({ rows, virtualize: false, markdown: true });
			try {
				const v = await runScript(virtual, rows);
				const e = await runScript(exact, rows);
				const startup = v.samples.get("startup")!;
				assert.strictEqual(startup[0].path, "virtual", "the first frame lays out only the rows in view");
				assert.strictEqual(startup.at(-1)!.path, "exact", "the layout settles");
				assert.ok(e.samples.get("startup")!.every((frame) => frame.path === "exact"));
				for (const name of TRANSITIONS) {
					assert.strictEqual(
						firstScreenDifference(v.screens.get(name), e.screens.get(name)),
						undefined,
						`${name}: virtual and exact screens differ`,
					);
				}
				// After settling, interaction frames never go back to the virtual layout.
				for (const name of TRANSITIONS.slice(1, 6)) {
					const frames: FrameSample[] = v.samples.get(name)!;
					assert.ok(
						frames.every((frame) => frame.path === "exact"),
						`${name} stays exact`,
					);
				}
				assert.ok(virtual.searchOpen() && exact.searchOpen());
			} finally {
				virtual.stop();
				exact.stop();
			}
		});

		it(`${rows} Markdown rows: selection and search while the first layout is measured`, async () => {
			const virtual = createHarness({ rows, virtualize: true, markdown: true });
			const exact = createHarness({ rows, virtualize: false, markdown: true });
			try {
				const cold = await runCold(virtual);
				const reference = await runCold(exact);
				for (const [index, screen] of cold.screens.entries()) {
					assert.strictEqual(firstScreenDifference(screen, reference.screens[index]), undefined, `cold step ${index}`);
				}
			} finally {
				virtual.stop();
				exact.stop();
			}
		});
	}
});
