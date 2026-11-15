import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { completionInput } from "../../src/octocode/backlog/tool-arguments.ts";
import { oneWrite } from "../../src/octocode/backlog/tool-support.ts";
import { nativeToolDeferred, withNativeDeferral } from "../../src/octocode/permission/native-deferral.ts";
import { withReason } from "../../src/octocode/shared/reason.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/**
 * The rules the split of `backlog` into `backlog` and `backlogPlan` added: reads run beside each other, what a call may
 * carry is declared, a verification that names no result is recorded as that, refusals say what to do next, and the
 * planning tool can be declared deferred.
 */

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-backlog-split-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	vi.unstubAllEnvs();
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const READY = { goal: "Result can be checked", why: "Users need it" };

async function setup() {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ctx = fakeCtx({ cwd });
	/** Runs a call as the agent loop does: validated against the tool's validation schema, then executed. */
	const call = async (params: Record<string, unknown>, signal?: AbortSignal) => {
		const name = backlogToolName(params.op);
		const tool = fake.tools.get(name);
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "t",
			name,
			arguments: { ...params, reason: "test" },
		});
		const result = (await tool.execute("id", args, signal, undefined, ctx)) as { content: Array<{ text: string }> };
		return result.content[0].text;
	};
	await call({ op: "add", items: [{ ...READY, title: "first", state: "todo" }] });
	return { call, tools: fake.tools, store: () => openBacklog(ctx, { isSubagent: false }).store };
}

type Concurrency = (args: Record<string, unknown>) => "shared" | "exclusive";

describe("G1: reads run shared, writes exclusive", () => {
	it("declares get and list shared and every write exclusive", async () => {
		const { tools } = await setup();
		const work = tools.get("backlog").concurrency as Concurrency;
		const plan = tools.get("backlogPlan").concurrency as Concurrency;
		expect(work({ op: "get" })).toBe("shared");
		for (const op of ["claim", "note", "done", "close", "update"]) expect(work({ op }), op).toBe("exclusive");
		expect(plan({ op: "list" })).toBe("shared");
		for (const op of ["add", "edit"]) expect(plan({ op }), op).toBe("exclusive");
	});

	it("answers a read while a write holds the store, and queues the next write behind it", async () => {
		const { call } = await setup();
		let release!: () => void;
		const held = oneWrite(() => new Promise<void>((resolve) => (release = resolve)));
		// Both reads return while the write lock is held.
		expect(await call({ op: "get", id: "B1" })).toContain("first");
		expect(await call({ op: "list" })).toContain("B1");
		let noted = false;
		const note = call({ op: "note", id: "B1", note: "progress" }).then((text) => {
			noted = true;
			return text;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(noted).toBe(false);
		release();
		await held;
		expect(await note).toContain("B1");
		expect(await call({ op: "get", id: "B1" })).toContain("progress");
	});

	it.each([
		{ op: "add", items: [{ ...READY, title: "Cancelled proposal" }] },
		{ op: "edit", items: [{ id: "B1", title: "Cancelled edit" }] },
	])("does not apply a queued $op after cancellation", async (params) => {
		const { call, store } = await setup();
		const before = store().get("B1");
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => (entered = resolve));
		const held = oneWrite(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
					entered();
				}),
		);
		await started;
		const controller = new AbortController();
		const queued = call(params, controller.signal);
		const refused = expect(queued).rejects.toThrow("Cancelled queued plan");
		controller.abort(new Error("Cancelled queued plan"));
		release();
		await held;
		await refused;
		expect(store().list().total).toBe(1);
		expect(store().get("B1")).toEqual(before);
		// The aborted callback must release the write queue for the next operation.
		await call({ op: "edit", items: [{ id: "B1", priority: "p1" }] });
		expect(store().get("B1")!.priority).toBe(1);
	});
});

describe("G2: a verification that names no result is not recorded as passed", () => {
	it.each([
		["Passed: yarn vitest run backlog", "passed"],
		["yarn vitest run backlog: 37 files passed", "passed"],
		["yarn test, no failures, all green", "passed"],
		["Not applicable: documentation only", "not_applicable"],
		["Failed: 2 tests red", "failed"],
		["Not run: no test covers it", "not_run"],
		["ran the check", "not_stated"],
		["37 passed, 2 failed", "not_stated"],
		["the tests did not pass", "not_stated"],
		["looked at the output", "not_stated"],
	])("%j is %s", (verification, status) => {
		expect(completionInput({ summary: "Done", verification }).verification).toEqual({ status, summary: verification });
	});

	it.each(["ran the check", "37 passed, 2 failed"])(
		"refuses an agent's done whose verification %j names no result, keeping the item ongoing",
		async (verification) => {
			const { call, store } = await setup();
			await call({ op: "claim", id: "B1" });
			await expect(call({ op: "done", id: "B1", completion: { summary: "Done", verification } })).rejects.toThrow(
				/names no result: start it with passed or not applicable/,
			);
			expect(store().get("B1")!.state).toBe("ongoing");
			expect(store().get("B1")!.completions).toEqual([]);
		},
	);

	it("says nothing extra when the result is stated, and takes the declared retry key", async () => {
		const { call, store } = await setup();
		await call({ op: "claim", id: "B1" });
		const completion = { summary: "Done", verification: "Passed: focused tests", operationKey: "retry-1" };
		const out = await call({ op: "done", id: "B1", completion });
		expect(out).not.toContain("not stated");
		expect(store().get("B1")!.completions.at(-1)).toMatchObject({
			operationKey: "retry-1",
			verification: { status: "passed" },
		});
		expect(await call({ op: "done", id: "B1", completion })).toContain("Completion retry-1 of B1 was already recorded");
	});
});

describe("G4: refusals say what to do next", () => {
	it("answers a version conflict with the current version and the call to make", async () => {
		const { call, store } = await setup();
		const stale = store().get("B1")!.version;
		await call({ op: "note", id: "B1", note: "moved on" });
		await expect(call({ op: "note", id: "B1", note: "late", version: stale })).rejects.toThrow(
			`B1 changed elsewhere (now version ${stale + 1}): get it, then retry.`,
		);
		await expect(call({ op: "edit", items: [{ id: "B1", priority: "p1", version: stale }] })).rejects.toThrow(
			`B1 changed elsewhere (now version ${stale + 1}): get it, then retry.`,
		);
		// The store's own text is the board's, which a person reloads.
		expect(() => store().update("B1", { title: "x", version: stale }, { id: "me" })).toThrow(
			"B1 changed elsewhere — reload it.",
		);
	});

	it("names the valid values of a state, a version and an entry's fields", async () => {
		const { call, store } = await setup();
		expect(() => store().update("B1", { state: "paused" as never }, { id: "me" })).toThrow(
			"Unknown backlog state paused: use backlog, todo, ongoing, done.",
		);
		expect(() => store().update("B1", { title: "x", version: 0 }, { id: "me" })).toThrow(
			"version must be a positive integer: the version get shows for the item.",
		);
		const fields = "title, goal, why, type, parentId, dependsOn, paths, evidence, plan, priority, tags, from, links";
		await expect(call({ op: "add", items: [{ ...READY, title: "t", bogus: 1 }] })).rejects.toThrow(
			`Unknown items fields: bogus. An entry takes ${fields}, state, note.`,
		);
		await expect(call({ op: "edit", items: [{ id: "B1", bogus: 1 }] })).rejects.toThrow(
			`Unknown items fields: bogus. An entry takes id, ${fields}, state, note.`,
		);
		await expect(call({ op: "add", bogus: 1 })).rejects.toThrow(
			`Unknown backlogPlan fields: bogus. add takes items, one entry per item: ${fields}, state, note.`,
		);
	});
});

describe("deferred declaration", () => {
	const api = (settings: object) => ({ getSettings: () => settings }) as never;

	it("defers backlogPlan under recent exposure and never backlog", async () => {
		vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", path.join(tmp, "agent"));
		const { tools } = await setup();
		expect(nativeToolDeferred("backlogPlan", { mcpExposure: "recent" })).toBe(true);
		expect(nativeToolDeferred("backlog", { mcpExposure: "recent" })).toBe(false);
		const plan = tools.get("backlogPlan");
		const declared = { ...plan, parameters: withReason(plan.parameters) };
		const thin = withNativeDeferral(api({ mcpExposure: "recent" }), declared as never) as unknown as {
			description: string;
			parameters: { properties: Record<string, unknown>; required: string[] };
			validationHint: (failure: { envelope: boolean; properties: string[] }) => string;
		};
		// The thin declaration has no schema for an entry.
		expect(thin.parameters.properties.items).toEqual({ type: "array" });
		expect(thin.parameters.required).toEqual(["reason"]);
		// A refused call returns the declared schema with its typed entry, not the looser one calls are validated against.
		const hint = thin.validationHint({ envelope: false, properties: ["op"] });
		expect(hint).toContain('"enum":["add","edit","list"]');
		expect(hint).toContain('"title":{"type":"string"');
		expect(hint).not.toContain('"items":{"type":"object"}');
		const work = tools.get("backlog");
		expect(withNativeDeferral(api({ mcpExposure: "recent" }), work as never).parameters).toBe(work.parameters);
	});
});

describe("declaration size", () => {
	const bytes = (tool: { name: string; description: string; parameters: unknown }) =>
		Buffer.byteLength(
			JSON.stringify({
				name: tool.name,
				description: tool.description,
				input_schema: withReason(tool.parameters as never),
			}),
		);

	it("keeps the always-declared work tool small and the planning tool under the old single declaration", async () => {
		const { tools } = await setup();
		const work = bytes(tools.get("backlog"));
		const plan = bytes(tools.get("backlogPlan"));
		// The single `backlog` declaration was 4,682 bytes in the last generated request. Measured 1,684 and 3,606:
		// a child declares the first alone, and the second is deferred until a working directory plans.
		expect(work).toBeLessThan(1_700);
		expect(plan).toBeLessThan(3_650);
	});
});
