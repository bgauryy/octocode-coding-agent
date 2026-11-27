import { describe, expect, it } from "vitest";
import { DEFAULT_ITEM_TYPE, ITEM_TYPES, isItemType, isOpenTask, TASK_STATES } from "../src/backlogs.ts";
import { STATES, deriveEpicState } from "../src/snapshot.ts";

describe("item types", () => {
	it("lists epic first and names the default feature", () => {
		expect(ITEM_TYPES).toEqual(["epic", "feature", "bug", "research"]);
		expect(DEFAULT_ITEM_TYPE).toBe("feature");
	});

	it("names only the current types: the former name task is not one", () => {
		expect(isItemType("bug")).toBe(true);
		for (const name of ["task", "story", "toString"]) expect(isItemType(name), name).toBe(false);
	});
});

describe("tasks", () => {
	it("are open while todo or ongoing", () => {
		expect(TASK_STATES.filter(isOpenTask)).toEqual(["todo", "ongoing"]);
	});
});

describe("deriveEpicState", () => {
	it("rolls children up: done, ongoing, todo, then backlog; no children keeps the stored state", () => {
		expect(deriveEpicState("todo", [])).toBe("todo");
		expect(deriveEpicState("backlog", ["done", "done"])).toBe("done");
		expect(deriveEpicState("done", ["done", "ongoing", "todo"])).toBe("ongoing");
		expect(deriveEpicState("backlog", ["backlog", "todo", "done"])).toBe("todo");
		expect(deriveEpicState("todo", ["backlog", "done"])).toBe("backlog");
		for (const state of STATES) expect(deriveEpicState("todo", [state])).toBe(state);
	});
});
