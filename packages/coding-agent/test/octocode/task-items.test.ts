import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { findItemIds, itemsSection, withItems } from "../../src/octocode/subagents/task-items.ts";
import { fakeCtx } from "./fake-host.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-task-items-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function workspace() {
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd }) as Parameters<typeof withItems>[2];
	const { store } = openBacklog(ctx, { isSubagent: false });
	return { ctx, store };
}

describe("findItemIds", () => {
	it("finds each id once and ignores look-alikes", () => {
		expect(findItemIds("Triage B12, then B3 and B12 again; not AB4, B2B, #B5 or report:B6")).toEqual(["B12", "B3"]);
	});
});

describe("a child task that names backlog items", () => {
	it("gets the item text of its own workspace, and names an unknown id", () => {
		const { ctx, store } = workspace();
		const item = store.add({
			title: "Read-only boards",
			goal: "Researchers read items",
			why: "No tool",
			createdBy: "t",
		});
		const brief = withItems("", { task: `Check ${item.ref} and B999` }, ctx);
		expect(brief).toContain("## Backlog items");
		expect(brief).toContain(`${item.ref} [`);
		expect(brief).toContain("Read-only boards");
		expect(brief).toContain("Goal: Researchers read items");
		expect(brief).toContain("Why: No tool");
		expect(brief).toContain("Not on this workspace's board: B999.");
	});

	it("adds nothing when the child is given the item or the task names none", () => {
		const { ctx, store } = workspace();
		const item = store.add({ title: "Own item", goal: "g", createdBy: "t" });
		expect(withItems("ref", { task: `Do ${item.ref}`, item: item.ref }, ctx)).toBe("ref");
		expect(withItems("ref", { task: "no ids here" }, ctx)).toBe("ref");
	});

	it("says when it leaves items out for size", () => {
		const { store } = workspace();
		const refs = Array.from(
			{ length: 10 },
			(_, index) => store.add({ title: `Item ${index}`, goal: "g", createdBy: "t" }).ref,
		);
		const section = itemsSection(refs.join(" "), store);
		expect(section).toContain("Left out to keep the brief short");
		expect(section).toContain(refs[9]);
	});

	it("never lets a clipped field exceed its budget", () => {
		const { store } = workspace();
		const item = store.add({ title: "Long", goal: "g".repeat(2000), createdBy: "t" });
		const goal = itemsSection(item.ref, store)
			.split("\n")
			.find((line) => line.startsWith("Goal: "))!;
		expect(goal.slice("Goal: ".length)).toHaveLength(600);
		expect(goal.endsWith("…")).toBe(true);
	});
});
