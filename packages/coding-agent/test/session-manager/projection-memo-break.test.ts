/**
 * The differential check must catch a wrong kept projection: each test breaks how the kept projection is extended by
 * appends and expects `runProperty` to report a mismatch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Context from "../../src/core/session-manager/context.ts";
import type * as Index from "../../src/core/session-manager/entry-index.ts";
import { runProperty } from "./projection-property.ts";

const broken = vi.hoisted(() => ({ mode: "none" as "none" | "settings" | "edits" | "stale" | "branch", extended: 0 }));

vi.mock("../../src/core/session-manager/context.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Context>();
	return {
		...actual,
		extendProjection: (parts: Context.ProjectionParts, appended: Parameters<typeof actual.extendProjection>[1]) => {
			if (broken.mode === "stale") return appended.every((entry) => entry.type !== "compaction");
			const settings = { thinkingLevel: parts.thinkingLevel, model: parts.model };
			const projected = parts.projected.slice();
			const extended = actual.extendProjection(parts, appended);
			if (extended) broken.extended++;
			if (broken.mode === "settings") Object.assign(parts, settings);
			if (broken.mode === "edits" && projected.some((entry, i) => parts.projected[i] !== entry)) {
				parts.projected.splice(0, projected.length, ...projected);
				parts.messages = undefined;
			}
			return extended;
		},
	};
});

vi.mock("../../src/core/session-manager/entry-index.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Index>();
	return {
		...actual,
		// A kept branch path that misses the entries appended after its tail.
		branchPath: (...args: Parameters<typeof actual.branchPath>) => {
			const path = actual.branchPath(...args);
			return broken.mode === "branch" && path.length > 2 ? path.slice(0, -1) : path;
		},
	};
});

const seeds = Array.from({ length: 12 }, (_, i) => i + 1);

describe("the differential check of the kept projection", () => {
	beforeAll(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
	});
	afterAll(() => vi.useRealTimers());

	it("passes with the projection extended as it should be, and extends it on most reads", () => {
		broken.mode = "none";
		broken.extended = 0;
		expect(runProperty(seeds, 250)).toEqual([]);
		expect(broken.extended).toBeGreaterThan(1000);
	});

	it.each(["settings", "edits", "stale", "branch"] as const)("fails when the extension breaks: %s", (mode) => {
		broken.mode = mode;
		const mismatches = runProperty(seeds, 250);
		broken.mode = "none";
		expect(mismatches.length).toBeGreaterThan(0);
	});
});
