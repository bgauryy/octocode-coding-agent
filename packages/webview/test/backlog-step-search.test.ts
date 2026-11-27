import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import type { Snapshot } from "@octocodeai/octocode-contracts/snapshot";
import { expect, it } from "vitest";
import { filterBoard, filterTable, indexBacklog } from "../src/app/model/backlog.ts";
import { snapshotItem } from "./helpers.ts";

it("finds checklist references, goals, reasons and evidence in both board and table after a step update", () => {
	const step: BacklogTask = {
		ref: "T12",
		seq: 12,
		rowId: 12,
		goal: "Check symlinks",
		reason: "Avoid traversal",
		result: "",
		state: "todo",
		owner: { kind: "item", ref: "B1" },
		position: 0,
		version: 1,
		createdAt: 0,
		updatedAt: 0,
	};
	const snapshot: Snapshot = {
		repo: "repo",
		generatedAt: 1,
		states: ["todo"],
		idleMs: 1,
		items: [snapshotItem("B1", { tasks: [step] }), snapshotItem("B2")],
	};
	const before = indexBacklog(snapshot);
	for (const q of ["t12", "symlinks", "avoid traversal"]) {
		expect(filterBoard(before, { q }).map((item) => item.ref)).toEqual(["B1"]);
		expect(filterTable(before, { q }).map((item) => item.ref)).toEqual(["B1"]);
	}
	expect(filterBoard(before, { q: "regression passed" })).toEqual([]);
	const after = indexBacklog({
		...snapshot,
		items: [snapshotItem("B1", { tasks: [{ ...step, state: "done", result: "Symlink regression passed" }] })],
	});
	expect(filterBoard(after, { q: "REGRESSION PASSED" }).map((item) => item.ref)).toEqual(["B1"]);
	expect(filterTable(after, { q: "regression passed" }).map((item) => item.ref)).toEqual(["B1"]);
});
