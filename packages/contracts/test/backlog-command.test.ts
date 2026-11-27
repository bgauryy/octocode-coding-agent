import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { BacklogCommandSchema } from "../src/protocol.ts";

const valid = [
	{ command: "task.add", goal: "Write test", item: "B1" },
	{ command: "task.add", goal: "Session step", session: "s-1", state: "ongoing" },
	{ command: "task.update", task: "T2", version: 3, state: "done", result: "ok" },
	{ command: "task.move", task: "T2", version: 1, position: 0 },
	{ command: "task.reparent", task: "T2", version: 1, item: "B7" },
	{ command: "task.promote", task: "T2", version: 1, parentId: "B3", type: "feature", state: "todo" },
	{ command: "item.reparent", id: "B4", version: 2, parentId: null },
	{ command: "item.state", id: "B4", version: 2, state: "ongoing" },
];
const invalid = [
	{ command: "task.delete", task: "T1" },
	{ command: "task.update", task: "T1" },
	{ command: "task.update", task: "1", version: 1 },
	{ command: "task.move", task: "T1", version: 1, position: -1 },
	{ command: "task.add", goal: "x", item: "T1" },
	{ command: "task.add", goal: "x", surprise: true },
	{ command: "item.state", id: "B1", version: 1, state: "dropped" },
	{ command: "item.reparent", id: "B1", version: 0, parentId: "B2" },
];

describe("BacklogCommandSchema", () => {
	it.each(valid)("accepts $command", (command) => expect(Value.Check(BacklogCommandSchema, command)).toBe(true));
	it.each(invalid)("rejects %j", (command) => expect(Value.Check(BacklogCommandSchema, command)).toBe(false));
});
