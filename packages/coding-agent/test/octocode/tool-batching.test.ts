import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { backlogToolName, planEntryFields } from "./backlog-fixture.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-tool-batching-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function setup() {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const call = () => async (params: Record<string, unknown>) => {
		const name = backlogToolName(params.op);
		const tool = fake.tools.get(name);
		const valid = validateToolArguments(tool, {
			type: "toolCall",
			id: "id",
			name,
			arguments: { reason: "test", ...params },
		});
		const out = (await tool.execute("id", valid, undefined, undefined, fakeCtx({ cwd }))) as {
			content: Array<{ text: string }>;
		};
		return out.content[0].text;
	};
	return { backlog: call() };
}

const ready = { goal: "Result can be checked", why: "Users need it" };

describe("declarations", () => {
	it("declares items entries with a typed schema on backlogPlan only, and no steps array", () => {
		const schema = (isSubagent: boolean, name: string) => {
			const fake = fakeHost();
			registerBacklog(fake.api, { commands: new Subcommands(), isSubagent });
			return fake.tools.get(name);
		};
		const plan = schema(false, "backlogPlan");
		const entry = (plan.parameters as { properties: { items: { items: Record<string, unknown> } } }).properties.items
			.items;
		// An entry is a closed object naming every field `add` and `edit` write: never a bare `{type: "object"}`.
		expect(entry).toMatchObject({ type: "object", additionalProperties: false });
		const fields = planEntryFields(plan);
		const single = ["title", "goal", "why", "type", "parentId", "dependsOn", "paths", "evidence", "plan", "priority"];
		expect(Object.keys(fields)).toEqual(["id", "version", ...single, "tags", "from", "links", "state", "note"]);
		for (const [name, field] of Object.entries(fields)) {
			expect(field.type ?? field.anyOf, name).toBeDefined();
			// `tags` is named for what it holds; every other field says how to fill it.
			if (name !== "tags") expect(field.description, name).toBeTruthy();
		}
		expect(fields.paths).toMatchObject({ type: "array", items: { type: "string" } });
		expect(fields.priority.enum).toEqual(["p0", "p1", "p2", "p3"]);
		expect(JSON.stringify(plan.parameters)).not.toContain('"items":{"type":"object"}');
		// The item fields exist only inside an entry.
		const top = Object.keys((plan.parameters as { properties: object }).properties);
		for (const name of Object.keys(fields)) expect(top, name).not.toContain(name);
		const properties = (name: string, isSubagent = false) =>
			(schema(isSubagent, name).parameters as { properties: Record<string, unknown> }).properties;
		expect(properties("backlog").items).toBeUndefined();
		expect(properties("backlog", true).items).toBeUndefined();
	});
});

describe("backlog add with items", () => {
	it("adds every entry in order and reports a refused one without stopping the rest", async () => {
		const { backlog } = setup();
		const out = await backlog({
			op: "add",
			priority: "p1",
			items: [
				{ title: "first", ...ready, state: "todo" },
				{ title: "no reason", goal: "g" },
				{ title: "third", ...ready, tags: ["batch"] },
			],
		});
		expect(out).toContain("Added 2 of 3; 1 refused.");
		expect(out).toMatch(/"no reason": refused - add needs why/);
		const list = await backlog({ op: "list", states: ["backlog", "todo"] });
		expect(list).toContain("first");
		expect(list).toContain("third");
		expect(list).not.toContain("no reason");
		// An item field written beside items (a shape models send) is read as the default of every entry.
		expect(await backlog({ op: "list", priorityAtLeast: "p1", states: ["backlog", "todo"] })).toContain("third");
	});

	it("refuses an entry with an unknown field or a wrong value on its own row, and items beside a title or another op", async () => {
		const { backlog } = setup();
		const out = await backlog({
			op: "add",
			items: [
				{ title: "x", ...ready, bogus: 1 },
				{ title: "bad priority", ...ready, priority: "p9" },
				{ title: "kept", ...ready, paths: ["src/a.ts"] },
			],
		});
		expect(out).toContain("Added 1 of 3; 2 refused.");
		expect(out).toMatch(/"x": refused - .*bogus/);
		expect(out).toMatch(/"bad priority": refused - .*priority/);
		expect(await backlog({ op: "list", states: ["backlog"] })).not.toContain("bad priority");
		await expect(backlog({ op: "add", title: "x", items: [{ title: "y", ...ready }] })).rejects.toThrow(
			/add with items takes no title beside them: each entry carries its own title/,
		);
		await expect(backlog({ op: "edit", id: "B1", items: [{ title: "y", ...ready }] })).rejects.toThrow(
			/edit with items takes no id beside them/,
		);
	});

	it("leaves the single add unchanged", async () => {
		const { backlog } = setup();
		expect(await backlog({ op: "add", items: [{ title: "solo", ...ready }] })).toMatch(/^Added .*solo/);
		await expect(backlog({ op: "add", items: [{ title: "x", goal: "g" }] })).rejects.toThrow(/add needs why/);
	});
});
