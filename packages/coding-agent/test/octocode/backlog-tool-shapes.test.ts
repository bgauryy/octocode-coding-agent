import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/** One regression test per call-shape mistake seen in recorded sessions (.octocode/coordinator-plan/backlog-model.md §3). */

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-shapes-")));
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
	/** Runs a call as the agent loop does: arguments are validated against the tool's validation schema first. */
	const text = async (params: Record<string, unknown>) => {
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "t",
			name: "backlog",
			arguments: { ...params, reason: "test" },
		});
		return (
			(await tool.execute("id", args, undefined, undefined, fakeCtx({ cwd }))) as { content: Array<{ text: string }> }
		).content[0].text;
	};
	for (const title of ["first", "second", "third"])
		await text({ op: "add", title, goal: `${title} done`, why: `${title} needed`, state: "todo" });
	return { text, tool };
}

describe("E: several ids in one string", () => {
	it.each(["B1,B3", "B1, B3", "B1 B3"])("reads %j as a list on get", async (id) => {
		const { text } = await setup();
		const out = await text({ op: "get", id });
		expect(out).toContain("first");
		expect(out).toContain("third");
		expect(out).not.toContain("second");
	});

	it("reads ids sent as JSON text, and says update takes one id", async () => {
		const { text } = await setup();
		expect(await text({ op: "get", ids: '["B1","B2"]' })).toContain("second");
		await expect(text({ op: "update", id: "B1, B2", note: "x" })).rejects.toThrow(/update takes one id: use updates/);
	});
});

describe("B: lists and objects sent as JSON text", () => {
	it("parses items and updates once", async () => {
		const { text } = await setup();
		const items = JSON.stringify([{ title: "From text", goal: "g", why: "w" }]);
		expect(await text({ op: "add", items })).toMatch(/^Added 1 of 1\./);
		const updates = JSON.stringify([{ id: "B1", note: "via text" }]);
		expect(await text({ op: "update", updates })).toMatch(/^Updated 1 of 1\./);
		expect(await text({ op: "get", id: "B1" })).toContain("via text");
	});

	it("parses paths, tags, evidence and dependsOn once", async () => {
		const { text } = await setup();
		const out = await text({
			op: "add",
			title: "Typed",
			goal: "g",
			why: "w",
			paths: '["src/a.ts","src/b.ts"]',
			tags: '["x","y"]',
			evidence: '["src/a.ts:3 - the call"]',
			dependsOn: '["B1"]',
		});
		expect(out).toMatch(/^Added B4/);
		const item = await text({ op: "get", id: "B4" });
		expect(item).toContain("Where: src/a.ts, src/b.ts");
		expect(item).toContain("src/a.ts:3 - the call");
		expect(item).toContain("Depends on: B1");
		expect(item).toMatch(/#x/);
	});

	it("parses a completion sent as JSON text", async () => {
		const { text } = await setup();
		await text({ op: "update", id: "B1", state: "ongoing" });
		const completion = JSON.stringify({ summary: "Done", verification: "ran the check" });
		expect(await text({ op: "update", id: "B1", state: "done", completion })).toMatch(/^Updated B1/);
	});
});

describe("D: batch rows take every add field", () => {
	it("adds a mixed bug and research batch with parentId and from, with defaults beside items", async () => {
		const { text } = await setup();
		await text({ op: "add", title: "Group", goal: "g", why: "w", type: "epic" });
		const out = await text({
			op: "add",
			why: "found while reviewing",
			from: "B1",
			priority: "p1",
			items: [
				{ title: "Fix crash", goal: "no crash", type: "bug", parentId: "B4", tags: ["crash"], paths: ["src/a.ts"] },
				{
					title: "Study cache",
					goal: "report",
					type: "research",
					from: "B2",
					plan: "read",
					evidence: ["src/b.ts:1 - x"],
					state: "ongoing",
					note: "start",
				},
				{ title: "Wait", goal: "later", dependsOn: ["B3"], state: "todo" },
			],
		});
		expect(out).toMatch(/^Added 3 of 3\./);
		expect(out).not.toMatch(/Unknown items fields/);
		const bug = await text({ op: "get", id: "B5" });
		expect(bug).toMatch(/Type: bug/);
		expect(bug).toContain("Parent: B4");
		expect(bug).toMatch(/p1/);
		expect(await text({ op: "get", id: "B6" })).toMatch(/Type: research/);
	});

	it("returns an error result when every row is refused, and a plain result when some apply", async () => {
		const { text } = await setup();
		await expect(
			text({
				op: "add",
				why: "w",
				items: [
					{ title: "No goal", goal: "g", bogus: 1 },
					{ title: "Bad", goal: "g", parentId: "B99" },
				],
			}),
		).rejects.toThrow(/Added 0 of 2; 2 refused\.[\s\S]*Unknown items fields: bogus/);
		await expect(text({ op: "update", updates: [{ id: "B99", note: "x" }] })).rejects.toThrow(
			/Updated 0 of 1; 1 refused\./,
		);
		expect(
			await text({
				op: "add",
				why: "w",
				items: [
					{ title: "Ok", goal: "g" },
					{ title: "Bad", goal: "g", bogus: 1 },
				],
			}),
		).toMatch(/^Added 1 of 2; 1 refused\./);
	});
});

describe("A: completion in the light shape", () => {
	const claim = async (text: (p: Record<string, unknown>) => Promise<string>, id = "B1") =>
		text({ op: "update", id, state: "ongoing" });

	it("stores a one-sentence verification as passed, with files as changed paths", async () => {
		const { text } = await setup();
		await claim(text);
		await text({
			op: "update",
			id: "B1",
			state: "done",
			completion: { summary: "Fixed", verification: "vitest: 12 passed", files: ["src/a.ts"], lesson: "Keep it small" },
		});
		const item = await text({ op: "get", id: "B1" });
		expect(item).toContain("Verification: passed — vitest: 12 passed");
		expect(item).toContain("Files: src/a.ts");
	});

	it("reads not applicable from the text, and refuses a failed one for an agent", async () => {
		const { text } = await setup();
		await claim(text);
		await text({
			op: "update",
			id: "B1",
			state: "done",
			completion: { summary: "Docs only", verification: "Not applicable: no code changed" },
		});
		expect(await text({ op: "get", id: "B1" })).toContain("Verification: not_applicable");
		await claim(text, "B2");
		await expect(
			text({
				op: "update",
				id: "B2",
				state: "done",
				completion: { summary: "x", verification: "Failed: 2 tests red" },
			}),
		).rejects.toThrow(/only with verification passed or not_applicable, not failed/);
	});

	it("still takes the stored shape", async () => {
		const { text } = await setup();
		await claim(text);
		await text({
			op: "update",
			id: "B1",
			state: "done",
			completion: {
				summary: "Done",
				files: [{ path: "src/a.ts", role: "reviewed" }],
				verification: { status: "passed", summary: "checked" },
			},
		});
		expect(await text({ op: "get", id: "B1" })).toContain("Verification: passed — checked");
	});

	it.each([
		[{ summary: "x" }, /completion\.verification is missing/],
		[{ verification: "ok" }, /completion\.summary is missing/],
		[{ summary: "x", verification: { summary: "s" } }, /completion\.verification\.status must be one of/],
		[{ summary: "x", verification: "ok", files: "a.ts" }, /completion\.files must be a list of paths/],
		[{ summary: "x", verification: "ok", notes: "n" }, /Unknown completion fields: notes/],
	])("names the problem in plain words for %j", async (completion, message) => {
		const { text } = await setup();
		await claim(text);
		await expect(text({ op: "update", id: "B1", state: "done", completion })).rejects.toThrow(message);
	});
});

describe("F: epics", () => {
	const epicWithItems = async () => {
		const ctx = await setup();
		await ctx.text({ op: "add", title: "Group", goal: "all done", why: "w", type: "epic" });
		await ctx.text({ op: "update", id: "B1", parentId: "B4" });
		await ctx.text({ op: "update", id: "B2", parentId: "B4" });
		return ctx;
	};
	const finish = async (text: (p: Record<string, unknown>) => Promise<string>, id: string) => {
		await text({ op: "update", id, state: "ongoing" });
		await text({ op: "update", id, state: "done", completion: { summary: "Done", verification: "checked" } });
	};

	it("closes from plain state done once its items are done or closed", async () => {
		const { text } = await epicWithItems();
		await expect(text({ op: "update", id: "B4", state: "done" })).rejects.toThrow(/Done needs completion/);
		await finish(text, "B1");
		await text({ op: "update", id: "B2", close: { kind: "obsolete", text: "not needed" } });
		expect(await text({ op: "update", id: "B4", state: "done" })).toMatch(/^Updated B4 \[done/);
		const epic = await text({ op: "get", id: "B4" });
		expect(epic).toMatch(/All 2 items are done or closed: B[12], B[12]\./);
		expect(epic).toContain("Verification: not_applicable");
	});

	it("refuses a completion while an item is still open", async () => {
		const { text } = await epicWithItems();
		await expect(
			text({
				op: "update",
				id: "B4",
				state: "done",
				completion: { summary: "Dropped the rest", verification: "Not applicable" },
			}),
		).rejects.toThrow(/Finish child items before completing their parent/);
	});

	it("explains how an epic with open items moves", async () => {
		const { text } = await epicWithItems();
		await expect(text({ op: "update", id: "B4", state: "ongoing" })).rejects.toThrow(
			/B4 is an epic with items: its state follows them \(2 of its 2 items are not done\).*once they are done/,
		);
	});
});

describe("P3: the served shape", () => {
	it("does not declare links, and takes them from older callers", async () => {
		const { text, tool } = await setup();
		const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props)).not.toContain("links");
		expect(Object.keys(props)).not.toContain("body");
		await text({ op: "update", id: "B1", links: [{ relation: "related", target: "B2" }] });
		expect(await text({ op: "get", id: "B1" })).toMatch(/Links:\n- related: B2/);
	});

	it("turns a path or URL in evidence into a link", async () => {
		const { text } = await setup();
		await text({ op: "update", id: "B1", evidence: ["src/a.ts", "https://example.com/x"] });
		expect(await text({ op: "get", id: "B1" })).toMatch(
			/Links:\n- evidence: src\/a\.ts\n- evidence: https:\/\/example\.com\/x/,
		);
	});

	it("shows notes on get and the logged changes only on request", async () => {
		const { text } = await setup();
		await text({ op: "update", id: "B1", state: "ongoing", note: "started the work" });
		const plain = await text({ op: "get", id: "B1" });
		expect(plain).toMatch(/Notes:\n- .* started the work/);
		expect(plain).not.toContain("Notes and changes");
		expect(plain).not.toMatch(/you · state todo → ongoing/);
		expect(plain).not.toContain("Audit (latest");
		const all = await text({ op: "get", id: "B1", changes: true });
		expect(all).toContain("Notes and changes:");
		expect(all).toMatch(/you · state todo → ongoing/);
		expect(all).toContain("started the work");
		expect(all).toContain("Audit (latest");
	});
});
