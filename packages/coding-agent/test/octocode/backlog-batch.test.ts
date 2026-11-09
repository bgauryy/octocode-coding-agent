import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-batch-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function setup() {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const tool = fake.tools.get("backlog");
	const text = async (params: Record<string, unknown>) =>
		((await tool.execute("id", params, undefined, undefined, fakeCtx({ cwd }))) as { content: Array<{ text: string }> })
			.content[0].text;
	for (const title of ["first", "second", "third"])
		await text({ op: "add", title, goal: `${title} done`, why: `${title} needed`, state: "todo" });
	return { text, tool };
}

const done = () => ({
	summary: "Implemented",
	files: [],
	verification: { status: "passed", summary: "Focused check passed" },
});

describe("backlog schema", () => {
	it("tells the model an epic follows its items", async () => {
		const { tool } = await setup();
		const props = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
		expect(props.state?.description).toMatch(/epic follows its items.*claim those, then set it done/);
	});

	it("accepts type, parent and note on each items entry, as a single add does", async () => {
		const { text } = await setup();
		const out = await text({
			op: "add",
			why: "group work",
			state: "ongoing",
			items: [
				{ title: "Group", goal: "group done", type: "epic" },
				{ title: "Child", goal: "child done", parentId: "B4", note: "started" },
			],
		});
		expect(out).toMatch(/^Added 2 of 2\./);
		expect(out).not.toMatch(/Unknown items fields/);
		expect(await text({ op: "get", id: "B4" })).toMatch(/epic/i);
		await expect(text({ op: "update", id: "B4", state: "todo" })).rejects.toThrow(
			/B4 is an epic with items: its state follows them \(1 of its 1 items are not done\) \(open: B5\).*list parentId B4/,
		);
	});

	it("adds finished work in one batch: an entry added as done carries its completion", async () => {
		const { text } = await setup();
		const out = await text({
			op: "add",
			why: "record finished work",
			state: "done",
			items: [
				{ title: "Finished", goal: "finished done", completion: done() },
				{ title: "Missing result", goal: "missing done" },
			],
		});
		expect(out).toMatch(/^Added 1 of 2; 1 refused\./);
		expect(out).not.toMatch(/Unknown items fields/);
		expect(out).toMatch(/Missing result.*Done needs completion/);
		expect(await text({ op: "get", id: "B4" })).toMatch(/done/);
	});

	it("says add needs why, and refuses an add without it", async () => {
		const { text, tool } = await setup();
		const props = (tool.parameters as { properties: Record<string, { description?: string }> }).properties;
		expect(props.why?.description).toMatch(/required for add/);
		await expect(text({ op: "add", title: "x", goal: "g" })).rejects.toThrow(/add needs why/);
	});
});

describe("backlog batch get", () => {
	it("returns each item's record and a not-found row for an unknown id", async () => {
		const { text } = await setup();
		const out = await text({ op: "get", id: "B1, B99,B3" });
		expect(out).toContain("B1");
		expect(out).toContain("first");
		expect(out).toContain("third");
		expect(out).toMatch(/B99: refused - No backlog item B99\./);
		expect(out).not.toContain("second");
	});

	it("takes ids as an array, one item or several", async () => {
		const { text } = await setup();
		const out = await text({ op: "get", ids: ["B1", "B99", "B3"] });
		expect(out).toContain("first");
		expect(out).toContain("third");
		expect(out).toMatch(/B99: refused - No backlog item B99\./);
		expect(out).not.toContain("second");
		expect(await text({ op: "get", ids: ["B2"] })).toContain("second");
		await expect(text({ op: "get", ids: [] })).rejects.toThrow(/get needs an id.*or ids/);
	});

	it("lists the items ids names, in any state", async () => {
		const { text } = await setup();
		const out = await text({ op: "list", ids: ["B1", "B3"] });
		expect(out).toContain("first");
		expect(out).toContain("third");
		expect(out).not.toContain("second");
	});

	it("keeps the single form unchanged", async () => {
		const { text } = await setup();
		expect(await text({ op: "get", id: "B2" })).toContain("second");
		await expect(text({ op: "get", id: "B99" })).rejects.toThrow(/No backlog item B99/);
	});
});

describe("backlog batch update", () => {
	it("applies the entries it can and reports the stale one with its reason", async () => {
		const { text } = await setup();
		const out = await text({
			op: "update",
			updates: [
				{ id: "B1", note: "progress on first" },
				{ id: "B2", version: 999, note: "stale" },
				{ id: "B3", state: "ongoing" },
			],
		});
		expect(out.split("\n")[0]).toBe("Updated 2 of 3; 1 refused.");
		expect(out).toMatch(/B2: refused - .*changed elsewhere/);
		expect(await text({ op: "get", id: "B1" })).toContain("progress on first");
		expect(await text({ op: "get", id: "B2" })).not.toContain("stale");
		expect(await text({ op: "get", id: "B3" })).toContain("ongoing");
	});

	it("enforces why and goal on a batch claim", async () => {
		const { text } = await setup();
		await text({ op: "add", title: "bare", why: "w", goal: "g" });
		const out = await text({
			op: "update",
			updates: [
				{ id: "B4", state: "ongoing", goal: " " },
				{ id: "B1", state: "ongoing" },
			],
		});
		expect(out.split("\n")[0]).toBe("Updated 1 of 2; 1 refused.");
		expect(out).toMatch(/B4: refused - .*goal/);
	});

	it("keeps done needing a completion for each entry", async () => {
		const { text } = await setup();
		const out = await text({
			op: "update",
			updates: [
				{ id: "B1", state: "done" },
				{ id: "B2", state: "done", completion: done() },
			],
		});
		expect(out.split("\n")[0]).toBe("Updated 1 of 2; 1 refused.");
		expect(out).toMatch(/B1: refused - .*completion/i);
	});

	it("refuses unknown entry fields per entry and mixing with a top-level id", async () => {
		const { text } = await setup();
		const out = await text({
			op: "update",
			updates: [
				{ id: "B1", bogus: 1 },
				{ id: "B2", note: "ok" },
			],
		});
		expect(out).toMatch(/B1: refused - Unknown update fields: bogus/);
		expect(out.split("\n")[0]).toBe("Updated 1 of 2; 1 refused.");
		await expect(text({ op: "update", id: "B1", updates: [{ id: "B2", note: "x" }] })).rejects.toThrow(
			/updates goes with/,
		);
	});

	it("takes a single update's item fields in an entry", async () => {
		const { text } = await setup();
		const out = await text({ op: "update", updates: [{ id: "B2", priority: "p1", dependsOn: ["B1"] }] });
		expect(out).not.toContain("refused");
		expect(await text({ op: "get", id: "B2" })).toMatch(/p1/);
	});

	it("keeps the single update unchanged", async () => {
		const { text } = await setup();
		expect(await text({ op: "update", id: "B1", note: "single" })).toMatch(/^Updated B1/);
		await expect(text({ op: "update", id: "B1" })).rejects.toThrow(/update needs something to change/);
	});
});
