import { registerArchiveTool } from "../../src/octocode/archive/tool.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { parseTemplate } from "../../src/octocode/memory/command.ts";
import { MEMORY_HEADER } from "../../src/octocode/memory/inject.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import { memoryStore } from "../../src/octocode/memory/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { DAY_MS } from "../../src/octocode/shared/util.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";

// Memory recall and hygiene (B339): tool guidance, age labels, notices, keyword dedup, related memories, the body
// warning, subagent recall by goal, `/memory review` and the `reference` kind, each through the tool, hooks or command.

let root: string;
let cwd: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-memory-recall-"));
	cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", "");
	vi.stubEnv("OCTOCODE_MEMORY_AUTO", "");
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function setup(options: { isSubagent?: boolean; goal?: string } = {}) {
	const fake = fakeHost();
	const commands = new Subcommands();
	registerArchiveTool(
		fake.api,
		registerMemory(fake.api, {
			commands,
			isSubagent: options.isSubagent ?? false,
			permission: fakePermission(),
			goal: options.goal,
		}),
	);
	return { ...fake, tool: fake.tools.get("archive"), command: commands.get("memory") };
}

function ctxFor(options: { trusted?: boolean; hasUI?: boolean; branch?: unknown[] } = {}) {
	const ctx = fakeCtx({ cwd, hasUI: options.hasUI ?? true });
	Object.assign(ctx, { isProjectTrusted: () => options.trusted ?? true });
	Object.assign(ctx.sessionManager, { getBranch: () => options.branch ?? [] });
	return ctx;
}

const run = async (tool: any, params: Record<string, unknown>, ctx = ctxFor()) =>
	(
		await tool.execute(
			"call",
			{ goal: "Remember a preference", reason: "user requested", source: "memories", ...params },
			undefined,
			undefined,
			ctx,
		)
	).content[0].text as string;

describe("memory tool guidance", () => {
	it("declares identical description bytes for every role and splits when-to-save from when-to-read", () => {
		const main = setup().tool;
		const child = setup({ isSubagent: true }).tool;
		expect(child.description).toBe(main.description);
		expect(child.promptSnippet).toBe(main.promptSnippet);
		// The public Archive capability owns both history and memory.
		expect(main.promptSnippet).toMatch(/recalling preferences/);
		expect(main.promptSnippet).toMatch(/earlier sessions/);
		const guidance = main.promptGuidelines.join("\n");
		expect(guidance).toMatch(
			/corrects your approach, confirms a non-obvious one or what a report proposes, or asks you to remember/,
		);
		expect(guidance).toMatch(/Don't save what code, git history, AGENTS\.md, skills or the backlog/);
		expect(guidance).toMatch(/update or delete one that proves wrong/);
		expect(child.promptGuidelines).toEqual([
			expect.stringMatching(/^Memory is read-only here.*report one that proves wrong\.$/),
		]);
	});
});

describe("memory age labels", () => {
	it("shows each memory's age on tool lines and injected lines", async () => {
		const { tool, fire } = setup();
		memoryStore(cwd).set(
			{ title: "Rewind keeps checkpoints", body: "per session", kind: "decision", author: "agent" },
			Date.now() - 12 * DAY_MS - 1000,
		);
		expect(await run(tool, { op: "search", query: "checkpoints" })).toMatch(
			/^M1 \(workspace, decision, 12d\) Rewind keeps checkpoints/m,
		);
		const result = (await fire("before_agent_start", { prompt: "rewind checkpoints" }, ctxFor())) as any;
		expect(result.message.content.split("\n")[1]).toMatch(/^M1 \(workspace, decision, 12d\) \(agent-written\) "Rewind/);
	});
});

describe("memory notices (UI only)", () => {
	it("names the recalled memories once the injection is committed", async () => {
		const { fire } = setup();
		memoryStore(cwd).set({ title: "Rewind keeps checkpoints", author: "agent" });
		const ctx = ctxFor();
		const result = (await fire("before_agent_start", { prompt: "rewind checkpoints" }, ctx)) as any;
		expect(result.message.content.startsWith(MEMORY_HEADER)).toBe(true);
		expect(ctx.ui.notes).toEqual([]);
		await fire("message_end", { message: { role: "custom", ...result.message } }, ctx);
		expect(ctx.ui.notes).toEqual([{ message: "Recalled M1 (/memory last shows them)", type: "info" }]);
	});
});

describe("saving memories", () => {
	it("counts keywords in the duplicate check", async () => {
		const { tool } = setup();
		const keywords = "mcp octocode output contract structuresearch stale server restart";
		await run(tool, { op: "set", title: "Octocode server bugs", body: "restart fixes it", keywords });
		// Title and body share 2 of 7 words; with the shared keywords the overlap is 8 of 11.
		await expect(run(tool, { op: "set", title: "Stale server errors", body: "restart it", keywords })).rejects.toThrow(
			/Similar memory M1/,
		);
		expect(await run(tool, { op: "set", title: "Stale server errors", body: "restart it" })).toMatch(/^Saved M2/);
	});

	it("lists up to two related memories after a save, never the saved one", async () => {
		const { tool } = setup();
		await run(tool, { op: "set", title: "Yarn builds", body: "run yarn build at the root" });
		await run(tool, { op: "set", title: "Lint with oxlint", body: "yarn lint runs it" });
		await run(tool, { op: "set", title: "Format with oxfmt", body: "yarn format" });
		const saved = await run(tool, { op: "set", title: "Yarn tests", body: "yarn test in each package" });
		const related = saved.split("\n").find((line) => line.startsWith("Related: "));
		expect(related?.split("; ")).toHaveLength(2);
		expect(related).toMatch(/^Related: M1 Yarn builds; /);
		expect(related).not.toContain("M4");
		expect(await run(tool, { op: "set", title: "Unrelated zebra note" })).not.toContain("Related:");
	});

	it("keeps a long body but warns to shorten it", async () => {
		const { tool } = setup();
		const body = `${"word ".repeat(120)}end`;
		const saved = await run(tool, { op: "set", title: "Long note", body });
		expect(saved).toMatch(/^Saved M1/);
		expect(saved).toContain(`Kept, but the body is ${body.length} chars: shorten it to under 500`);
		expect(memoryStore(cwd).get(1)?.body).toBe(body);
		expect(await run(tool, { op: "set", title: "Short note", body: "brief" })).not.toContain("Kept, but");
	});
});

describe("subagent recall", () => {
	const brief = "You are a subagent. Shared context about teammates, scratch folders and reports.";

	it("searches by the child's goal instead of the brief", async () => {
		memoryStore(cwd).set({ title: "Parser rewrite plan", body: "tokens first", author: "agent" });
		const withGoal = setup({ isSubagent: true, goal: "parser rewrite" });
		const result = (await withGoal.fire("before_agent_start", { prompt: brief }, ctxFor())) as any;
		expect(result.message.details.ids).toEqual([1]);
		const withoutGoal = setup({ isSubagent: true });
		expect(await withoutGoal.fire("before_agent_start", { prompt: brief }, ctxFor())).toBeUndefined();
	});

	it("ignores a goal in the main session", async () => {
		memoryStore(cwd).set({ title: "Parser rewrite plan", body: "tokens first", author: "agent" });
		const main = setup({ goal: "parser rewrite" });
		expect(await main.fire("before_agent_start", { prompt: brief }, ctxFor())).toBeUndefined();
	});
});

describe("/memory review", () => {
	it("lists memories never used or not updated in N days, with why and how to act", async () => {
		const command = setup().command!;
		const store = memoryStore(cwd);
		const now = Date.now();
		const old = store.set({ title: "Old used note", author: "agent" }, now - 40 * DAY_MS).memory;
		const unused = store.set({ title: "Fresh unused note", author: "agent" }, now - DAY_MS).memory;
		const fresh = store.set({ title: "Recent popular entry", author: "agent" }, now - DAY_MS).memory;
		store.markUsed([old.id, fresh.id]);
		const ctx = ctxFor({ hasUI: false });
		await command.handler("review", ctx);
		expect(ctx.ui.notes.at(-1)!.message).toBe(
			[
				"Memories never used or not updated in 30 days:",
				`  M${old.id} (workspace, fact) Old used note (updated 40d ago)`,
				`  M${unused.id} (workspace, fact) Fresh unused note (never used, updated 1d ago)`,
				"Edit or delete one in the TUI: /memory, then pick it.",
			].join("\n"),
		);
		await command.handler("review 50", ctx);
		expect(ctx.ui.notes.at(-1)!.message).not.toContain("Old used note");
		await command.handler("review 0", ctx);
		expect(ctx.ui.notes.at(-1)).toEqual({ message: "Usage: /memory review [days]", type: "warning" });
	});

	it("opens the due memories in the picker, whose actions edit or delete them", async () => {
		const command = setup().command!;
		memoryStore(cwd).set({ title: "Unused note", author: "agent" });
		const ctx = ctxFor();
		const titles: string[] = [];
		// Pick the memory, choose Delete, then dismiss the list it returns to.
		Object.assign(ctx.ui, {
			select: async (title: string, options: string[]) => {
				titles.push(title);
				if (titles.length === 1) return options.find((option) => option.includes("Unused note"));
				return titles.length === 2 ? "Delete" : undefined;
			},
			confirm: async () => true,
		});
		await command.handler("review", ctx);
		expect(titles[0]).toBe("Memories never used or not updated in 30 days (pick one to edit or delete)");
		expect(titles[1]).toBe("M1 Unused note");
		expect(memoryStore(cwd).get(1)).toBeUndefined();
	});
});

describe("reference kind", () => {
	it("saves, reads and edits a reference memory beside the existing kinds", async () => {
		const { tool } = setup();
		expect(tool.parameters.properties.kind.enum).toEqual([
			"preference",
			"fact",
			"decision",
			"gotcha",
			"procedure",
			"reference",
		]);
		expect(
			await run(tool, {
				op: "set",
				title: "Release dashboard",
				body: "https://example.com/releases",
				kind: "reference",
			}),
		).toMatch(/^Saved M1 \(workspace, reference, 0d\) Release dashboard/);
		expect(memoryStore(cwd).get(1)?.kind).toBe("reference");
		expect(await run(tool, { op: "set", id: "M1", kind: "decision" })).toMatch(
			/^Updated M1 \(workspace, decision, 0d\)/,
		);
		expect(await run(tool, { op: "set", id: "M1", kind: "reference" })).toMatch(
			/^Updated M1 \(workspace, reference, 0d\)/,
		);
		expect(parseTemplate("kind: reference\n---\n").kind).toBe("reference");
	});

	it("ranks a memory nobody used for long below an equal one in use, and keeps a pinned one up", () => {
		const store = memoryStore(cwd);
		const old = Date.now() - 100 * DAY_MS;
		const add = (title: string, body: string, pinned = false) =>
			store.set({ title, body: `parser ${body}`, author: "agent", pinned }, old).memory;
		const unused = add("first entry", "tokens split on commas before lookup");
		const used = add("second thing", "errors recover at statement ends always");
		const pinned = add("third item", "grammar tables generated during builds nightly", true);
		store.markUsed([used.id]);
		const ids = store.search("parser").map((hit) => hit.id);
		expect(ids).toHaveLength(3);
		expect(ids.indexOf(used.id)).toBeLessThan(ids.indexOf(unused.id));
		expect(ids.indexOf(pinned.id)).toBeLessThan(ids.indexOf(unused.id));
	});
});
