import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateToolArguments } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";
import { backlogToolName } from "./backlog-fixture.ts";

/** One regression test per call-shape mistake seen in recorded sessions. */

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
		const name = backlogToolName(params.op);
		const called = fake.tools.get(name);
		const args = validateToolArguments(called, {
			type: "toolCall",
			id: "t",
			name,
			arguments: { ...params, reason: "test" },
		});
		return (
			(await called.execute("id", args, undefined, undefined, fakeCtx({ cwd }))) as {
				content: Array<{ text: string }>;
			}
		).content[0].text;
	};
	for (const title of ["first", "second", "third"])
		await text({ op: "add", items: [{ title, goal: `${title} done`, why: `${title} needed`, state: "todo" }] });
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

	it("reads ids sent as JSON text, and says a note takes one id", async () => {
		const { text } = await setup();
		expect(await text({ op: "get", ids: '["B1","B2"]' })).toContain("second");
		await expect(text({ op: "note", id: "B1, B2", note: "x" })).rejects.toThrow(
			/note takes one id: call it once per item/,
		);
	});
});

describe("B: lists and objects sent as JSON text", () => {
	it("parses the items of an add and of an edit once", async () => {
		const { text } = await setup();
		const items = JSON.stringify([{ title: "From text", goal: "g", why: "w" }]);
		expect(await text({ op: "add", items })).toMatch(/^Added B4 \[backlog p2\] From text/);
		const edits = JSON.stringify([{ id: "B1", note: "via text" }]);
		expect(await text({ op: "edit", items: edits })).toMatch(/^Updated B1 /);
		expect(await text({ op: "get", id: "B1" })).toContain("via text");
	});

	it("parses paths, tags, evidence and dependsOn once", async () => {
		const { text } = await setup();
		const out = await text({
			op: "add",
			items: [
				{
					title: "Typed",
					goal: "g",
					why: "w",
					paths: '["src/a.ts","src/b.ts"]',
					tags: '["x","y"]',
					evidence: '["src/a.ts:3 - the call"]',
					dependsOn: '["B1"]',
				},
			],
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
		await text({ op: "claim", id: "B1" });
		const completion = JSON.stringify({ summary: "Done", verification: "Passed: ran the check" });
		expect(await text({ op: "done", id: "B1", completion })).toMatch(/^Updated B1/);
	});
});

describe("F: item fields written beside op instead of inside an entry", () => {
	it("reads them as the one entry when there is no items, and refuses a title or id beside items", async () => {
		const { text } = await setup();
		expect(await text({ op: "add", title: "Flat", goal: "g", why: "w", priority: "p1" })).toBe(
			"Added B4 [backlog p1] Flat",
		);
		expect(await text({ op: "edit", id: "B4", tags: ["flat"] })).toMatch(/^Updated B4 \[backlog p1\] v\d+$/);
		await expect(text({ op: "add", title: "x", items: [{ title: "y", goal: "g", why: "w" }] })).rejects.toThrow(
			"add with items takes no title beside them: each entry carries its own title.",
		);
		await expect(text({ op: "edit", id: "B4", items: [{ id: "B1", priority: "p0" }] })).rejects.toThrow(
			"edit with items takes no id beside them: each entry carries its own id.",
		);
		await expect(text({ op: "add", id: "B1", title: "x", goal: "g", why: "w" })).rejects.toThrow(
			"Unknown backlogPlan fields: id.",
		);
		await expect(text({ op: "add" })).rejects.toThrow(
			"add needs items, one entry per item: items [{title, goal, why}].",
		);
		await expect(text({ op: "edit", items: [] })).rejects.toThrow(
			"edit needs items, one entry per item: items [{id, priority}].",
		);
	});
});

describe("D: batch rows take every add field", () => {
	it("adds a mixed bug and research batch with parentId and from, with defaults beside items", async () => {
		const { text } = await setup();
		await text({ op: "add", items: [{ title: "Group", goal: "g", why: "w", type: "epic" }] });
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
		// One entry answers as the single write does; several answer with a line each.
		await expect(text({ op: "edit", items: [{ id: "B99", note: "x" }] })).rejects.toThrow(/^No backlog item B99\./);
		await expect(
			text({
				op: "edit",
				items: [
					{ id: "B99", note: "x" },
					{ id: "B98", note: "y" },
				],
			}),
		).rejects.toThrow(/Updated 0 of 2; 2 refused\./);
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
	const claim = async (text: (p: Record<string, unknown>) => Promise<string>, id = "B1") => text({ op: "claim", id });

	it("stores a one-sentence verification as passed, with files as changed paths", async () => {
		const { text } = await setup();
		await claim(text);
		await text({
			op: "done",
			id: "B1",
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
			op: "done",
			id: "B1",
			completion: { summary: "Docs only", verification: "Not applicable: no code changed" },
		});
		expect(await text({ op: "get", id: "B1" })).toContain("Verification: not_applicable");
		await claim(text, "B2");
		await expect(
			text({
				op: "done",
				id: "B2",
				completion: { summary: "x", verification: "Failed: 2 tests red" },
			}),
		).rejects.toThrow(/only with verification passed or not_applicable, not failed/);
	});

	it("still takes the stored shape", async () => {
		const { text } = await setup();
		await claim(text);
		await text({
			op: "done",
			id: "B1",
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
		await expect(text({ op: "done", id: "B1", completion })).rejects.toThrow(message);
	});
});

describe("F: epics", () => {
	const epicWithItems = async () => {
		const ctx = await setup();
		await ctx.text({ op: "add", items: [{ title: "Group", goal: "all done", why: "w", type: "epic" }] });
		await ctx.text({ op: "edit", items: [{ id: "B1", parentId: "B4" }] });
		await ctx.text({ op: "edit", items: [{ id: "B2", parentId: "B4" }] });
		return ctx;
	};
	const finish = async (text: (p: Record<string, unknown>) => Promise<string>, id: string) => {
		await text({ op: "claim", id });
		await text({ op: "done", id, completion: { summary: "Done", verification: "Passed: checked" } });
	};

	it("closes from plain state done once its items are done or closed", async () => {
		const { text } = await epicWithItems();
		await expect(text({ op: "done", id: "B4" })).rejects.toThrow(/Done needs completion/);
		await finish(text, "B1");
		await text({ op: "close", id: "B2", close: { kind: "obsolete", text: "not needed" } });
		expect(await text({ op: "done", id: "B4" })).toMatch(/^Updated B4 \[done/);
		const epic = await text({ op: "get", id: "B4" });
		expect(epic).toMatch(/All 2 items are done or closed: B[12], B[12]\./);
		expect(epic).toContain("Verification: not_applicable");
	});

	it("refuses a completion while an item is still open", async () => {
		const { text } = await epicWithItems();
		await expect(
			text({
				op: "done",
				id: "B4",
				completion: { summary: "Dropped the rest", verification: "Not applicable" },
			}),
		).rejects.toThrow(/Finish child items before completing their parent/);
	});

	it("explains how an epic with open items moves", async () => {
		const { text } = await epicWithItems();
		await expect(text({ op: "claim", id: "B4" })).rejects.toThrow(
			/B4 is an epic with items: its state follows them \(2 of its 2 items are not done\).*once they are done/,
		);
	});
});

describe("P3: the served shape", () => {
	it("declares links only inside a backlogPlan entry, never on backlog", async () => {
		const { text, tool } = await setup();
		const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(Object.keys(props)).not.toContain("links");
		expect(Object.keys(props)).not.toContain("body");
		await text({ op: "edit", items: [{ id: "B1", links: [{ relation: "related", target: "B2" }] }] });
		expect(await text({ op: "get", id: "B1" })).toMatch(/Links:\n- related: B2/);
	});

	it("turns a path or URL in evidence into a link", async () => {
		const { text } = await setup();
		await text({ op: "edit", items: [{ id: "B1", evidence: ["src/a.ts", "https://example.com/x"] }] });
		expect(await text({ op: "get", id: "B1" })).toMatch(
			/Links:\n- evidence: src\/a\.ts\n- evidence: https:\/\/example\.com\/x/,
		);
	});

	it("shows notes on get and the logged changes only on request", async () => {
		const { text } = await setup();
		await text({ op: "claim", id: "B1", note: "started the work" });
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

describe("a call in the shape backlog had before backlogPlan", () => {
	/** The call as the agent loop runs it against `backlog`: validated, then executed. */
	async function former() {
		const { tool, text } = await setup();
		const call = async (params: Record<string, unknown>) => {
			const args = validateToolArguments(tool, {
				type: "toolCall",
				id: "t",
				name: "backlog",
				arguments: { ...params, reason: "test" },
			});
			return tool.execute("id", args, undefined, undefined, fakeCtx({ cwd: path.join(tmp, "repo") }));
		};
		return { tool, text, call };
	}

	it("is refused with one sentence naming the tool and op to use, never a schema error", async () => {
		const { call, text } = await former();
		await expect(call({ op: "list", states: ["todo"], tags: ["x"], limit: 5 })).rejects.toThrow(
			'backlog no longer lists items: call backlogPlan with op "list".',
		);
		await expect(call({ op: "add", title: "t", goal: "g", why: "w", priority: "p1", paths: ["a"] })).rejects.toThrow(
			'backlog no longer adds items: call backlogPlan with op "add".',
		);
		await expect(call({ op: "add", why: "w", items: [{ title: "t", goal: "g" }] })).rejects.toThrow(
			'backlog no longer adds items: call backlogPlan with op "add".',
		);
		const completion = { summary: "s", verification: "ran it" };
		for (const [fields, op] of [
			[{ state: "ongoing", why: "w", goal: "g" }, "claim"],
			[{ state: "done", completion }, "done"],
			[{ close: { kind: "obsolete", text: "gone" } }, "close"],
			[{ note: "progress" }, "note"],
		] as const)
			await expect(call({ op: "update", id: "B1", ...fields })).rejects.toThrow(
				`backlog has no op "update": use op "${op}".`,
			);
		for (const fields of [
			{ id: "B1", title: "renamed", paths: ["a"] },
			{ id: "B1", state: "todo" },
			{ updates: [{ id: "B1", priority: "p0" }] },
		])
			await expect(call({ op: "update", ...fields })).rejects.toThrow(
				'backlog has no op "update": call backlogPlan with op "edit".',
			);
		// Nothing was written by any of them.
		expect(await text({ op: "list", states: ["backlog", "todo", "ongoing", "done", "closed"] })).toBe(
			"B3 [todo p2] third\nB2 [todo p2] second\nB1 [todo p2] first",
		);
	});

	it("names the fields an operation takes when a call sends another tool's", async () => {
		const { call } = await former();
		await expect(call({ op: "claim", id: "B1", paths: ["a"] })).rejects.toThrow(
			"Unknown backlog fields: paths: backlog takes id, note, why, goal, completion, close, version; other fields change with backlogPlan op edit.",
		);
		await expect(call({ op: "note", id: "B1", note: "n", goal: "g" })).rejects.toThrow(
			"note does not take goal: it takes id, note, version.",
		);
		await expect(call({ op: "note", id: "B1" })).rejects.toThrow("note needs note: the progress or finding to append.");
		await expect(call({ op: "close", id: "B1" })).rejects.toThrow(/^close needs close: \{kind: obsolete, duplicate/);
	});

	it("still draws: a stored session replays the old arguments and result for display", async () => {
		const { tool } = await former();
		expect(rendered(tool.renderCall({ op: "list", query: "search", states: ["todo"] }, theme, {}))).toBe(
			'⏺ Backlog(list "search")',
		);
		expect(rendered(tool.renderCall({ op: "add", title: "Old item", from: "B1" }, theme, {}))).toBe(
			'⏺ Backlog(add from B1 "Old item")',
		);
		expect(rendered(tool.renderCall({ op: "update", id: "B2", state: "ongoing" }, theme, {}))).toBe(
			"⏺ Backlog(update B2 → ongoing)",
		);
		const row = (args: Record<string, unknown>, text: string, details: Record<string, unknown> = {}) =>
			rendered(
				tool.renderResult({ content: [{ type: "text", text }], details }, { expanded: false }, theme, {
					args,
					isPartial: false,
					expanded: false,
				}),
			);
		expect(row({ op: "list" }, "B2 [todo p2] second\nB1 [todo p2] first", { shown: 2, total: 2 })).toMatch(
			/^ {2}⎿ {2}2 items\n {5}B2 \[/,
		);
		const item = { ref: "B2", state: "ongoing", title: "second" };
		expect(row({ op: "update", id: "B2", state: "ongoing" }, "Updated B2 [ongoing p2] second (you)", { item })).toBe(
			"  ⎿  B2 → ongoing · second",
		);
		expect(row({ op: "add", title: "second" }, "Added B2 [backlog p2] second", { item })).toBe(
			"  ⎿  Added B2 · ongoing · second",
		);
		const shown = tool.display({
			args: { op: "update", id: "B2", state: "done" },
			result: { content: [{ type: "text", text: "Updated B2 [done p2] second" }], details: { item } },
			status: "completed",
		});
		expect(shown).toMatchObject({ title: "Backlog", summary: "B2 → ongoing · second" });
	});
});
