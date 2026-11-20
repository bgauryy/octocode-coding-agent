import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { parseTemplate } from "../../src/octocode/memory/command.ts";
import { MEMORY_HEADER, PINNED_BUDGET, selectInjection, TOTAL_BUDGET } from "../../src/octocode/memory/inject.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import { memoryStore } from "../../src/octocode/memory/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { DAY_MS } from "../../src/octocode/shared/util.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";

// Memory recall and hygiene: tool guidance, age labels, notices, keyword dedup, related memories, the body
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

function setup(
	options: {
		isSubagent?: boolean;
		goal?: string;
		recall?: "off" | "main" | "all";
		subagentPinnedKind?: "preference" | "fact" | "decision" | "gotcha" | "procedure" | "reference";
	} = {},
) {
	const memory = {
		...(options.recall ? { recall: options.recall } : {}),
		...(options.subagentPinnedKind ? { subagentPinnedKind: options.subagentPinnedKind } : {}),
	};
	const fake = fakeHost(Object.keys(memory).length > 0 ? { memory } : {});
	const commands = new Subcommands();
	registerMemory(fake.api, {
		commands,
		isSubagent: options.isSubagent ?? false,
		permission: fakePermission(),
		goal: options.goal,
	});
	return { ...fake, tool: fake.tools.get("memory"), command: commands.get("memory") };
}

function ctxFor(options: { trusted?: boolean; hasUI?: boolean; branch?: unknown[] } = {}) {
	const ctx = fakeCtx({ cwd, hasUI: options.hasUI ?? true, mode: "rpc" });
	Object.assign(ctx, { isProjectTrusted: () => options.trusted ?? true });
	Object.assign(ctx.sessionManager, { getBranch: () => options.branch ?? [] });
	return ctx;
}

const run = async (tool: any, params: Record<string, unknown>, ctx = ctxFor()) =>
	(
		await tool.execute(
			"call",
			{ goal: "Remember a preference", reason: "user requested", ...params },
			undefined,
			undefined,
			ctx,
		)
	).content[0].text as string;

describe("memory tool guidance", () => {
	it("declares identical description and snippet bytes for every role", () => {
		const main = setup().tool;
		const child = setup({ isSubagent: true }).tool;
		expect(child.description).toBe(main.description);
		expect(child.promptSnippet).toBe(main.promptSnippet);
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
		const result = (await fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: "rewind checkpoints" },
			ctxFor(),
		)) as any;
		expect(result.message.content.split("\n")[1]).toMatch(/^M1 \(workspace, decision, 12d\) \(agent-written\) "Rewind/);
	});
});

describe("memory notices (UI only)", () => {
	it("names the recalled memories once the injection is committed", async () => {
		const { fire } = setup();
		memoryStore(cwd).set({ title: "Rewind keeps checkpoints", author: "agent" });
		const ctx = ctxFor();
		const result = (await fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: "rewind checkpoints" },
			ctx,
		)) as any;
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

describe("what recall searches by", () => {
	const notice = (text: string) => ({
		systemPromptOptions: { sections: {}, contextFiles: [] },
		messageType: "custom",
		message: { role: "custom", customType: "octocode-bash-job", content: text, display: true, timestamp: 1 },
	});

	it("searches by a user's prompt, never by the text of an agent's result, a job notice or the compaction resume", async () => {
		memoryStore(cwd).set({ title: "Parser rewrite plan", body: "tokens first", author: "agent" });
		const pin = memoryStore(cwd).set({ title: "Reply in short sentences", pinned: true, author: "user" }).memory.id;
		const host = setup();
		// A machine-written wake that names the memory's words recalls nothing by them: only the unseen pin comes.
		const woke = (await host.fire("before_agent_start", notice("parser rewrite plan finished"), ctxFor())) as any;
		expect(woke.message.details.ids).toEqual([pin]);
		const child = setup({ isSubagent: true, goal: "parser rewrite" });
		expect(await child.fire("before_agent_start", notice("parser rewrite plan finished"), ctxFor())).toBeUndefined();
		// The user's prompt recalls by its words.
		const asked = (await host.fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: "how is the parser rewrite going?" },
			ctxFor(),
		)) as any;
		expect(asked.message.details.ids).toContain(1);
	});

	it("keeps the whole injected message, header and held-back note included, within the total budget", () => {
		const store = memoryStore(cwd);
		const names = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
		for (const name of names)
			store.set({ title: `Pin ${name} ${name}`, body: `${name} `.repeat(60), pinned: true, author: "user" });
		for (const name of names)
			store.set({ title: `Parser ${name} rewrite`, body: `parser rewrite ${name} `.repeat(30), author: "user" });
		const injection = selectInjection(store, { query: "parser rewrite note", scope: "all", seen: new Set(), topK: 10 });
		expect(injection?.content).toContain("more pinned memories");
		expect(injection!.content.length).toBeLessThanOrEqual(TOTAL_BUDGET);
	});
});

describe("subagent recall", () => {
	const brief = "You are a subagent. Shared context about teammates, scratch folders and reports.";
	const start = { systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief };

	it("follows memory.recall: by default (main) a subagent gets no notes from the database, off leaves main none", async () => {
		seedPins();
		memoryStore(cwd).set({ title: "Parser rewrite plan", body: "tokens first", author: "agent" });
		expect(
			await setup({ isSubagent: true, goal: "parser rewrite" }).fire("before_agent_start", start, ctxFor()),
		).toBeUndefined();
		expect(await setup({ recall: "off" }).fire("before_agent_start", start, ctxFor())).toBeUndefined();
		const main = (await setup().fire("before_agent_start", start, ctxFor())) as any;
		expect(main.message.details.ids.length).toBeGreaterThan(0);
	});

	it("searches by the child's goal instead of the brief", async () => {
		memoryStore(cwd).set({ title: "Parser rewrite plan", body: "tokens first", author: "agent" });
		const withGoal = setup({ isSubagent: true, goal: "parser rewrite", recall: "all" });
		const result = (await withGoal.fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief },
			ctxFor(),
		)) as any;
		expect(result.message.details.ids).toEqual([1]);
		const withoutGoal = setup({ isSubagent: true, recall: "all" });
		expect(
			await withoutGoal.fire(
				"before_agent_start",
				{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief },
				ctxFor(),
			),
		).toBeUndefined();
	});

	it("ignores a goal in the main session", async () => {
		memoryStore(cwd).set({ title: "Parser rewrite plan", body: "tokens first", author: "agent" });
		const main = setup({ goal: "parser rewrite" });
		expect(
			await main.fire(
				"before_agent_start",
				{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief },
				ctxFor(),
			),
		).toBeUndefined();
	});

	// Owner decision, 2026-11-11: a subagent's pins are the pinned preferences; every other pinned kind stays out.
	const seedPins = () => {
		const store = memoryStore(cwd);
		const pin = (title: string, kind: "preference" | "fact" | "decision" | "gotcha") =>
			store.set({ title, kind, pinned: true, author: "user" }).memory.id;
		return {
			preference: pin("Reply in short sentences", "preference"),
			fact: pin("Deploys run on Tuesdays", "fact"),
			decision: pin("Queue stays on SQLite", "decision"),
			gotcha: pin("Clock skew breaks leases", "gotcha"),
			unpinned: store.set({ title: "Tabs over spaces", kind: "preference", author: "user" }).memory.id,
		};
	};

	it("gives a subagent a pinned preference and no pinned fact, decision or other kind", async () => {
		const ids = seedPins();
		const child = setup({ isSubagent: true, recall: "all" });
		const result = (await child.fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief },
			ctxFor(),
		)) as any;
		expect(result.message.details.ids).toEqual([ids.preference]);
		expect(result.message.content).toContain("Reply in short sentences");
		expect(result.message.content).not.toContain("Deploys run on Tuesdays");
		// The other pinned kinds are not waiting for a later prompt either: nothing is announced as held back.
		expect(result.message.content).not.toContain("more pinned memor");
	});

	it("gives a subagent the pinned kind the memory.subagentPinnedKind setting names", async () => {
		const ids = seedPins();
		const child = setup({ isSubagent: true, recall: "all", subagentPinnedKind: "decision" });
		const result = (await child.fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief },
			ctxFor(),
		)) as any;
		expect(result.message.details.ids).toEqual([ids.decision]);
		expect(result.message.content).toContain("Queue stays on SQLite");
		expect(result.message.content).not.toContain("Reply in short sentences");
	});

	it("leaves the main session's pins unchanged: every pinned kind, no unpinned note without a hit", async () => {
		const ids = seedPins();
		const main = setup();
		const result = (await main.fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief },
			ctxFor(),
		)) as any;
		expect([...result.message.details.ids].sort((x: number, y: number) => x - y)).toEqual([
			ids.preference,
			ids.fact,
			ids.decision,
			ids.gotcha,
		]);
	});

	it("holds a subagent's pinned preferences to the pinned budget and counts only preferences as held back", async () => {
		const store = memoryStore(cwd);
		for (const name of ["alpha", "beta", "gamma", "delta"])
			store.set({
				title: `Style ${name}`,
				body: `${name} `.repeat(100),
				kind: "preference",
				pinned: true,
				author: "user",
			});
		store.set({ title: "Pinned fact", body: "omega ".repeat(100), pinned: true, author: "user" });
		const child = setup({ isSubagent: true, recall: "all" });
		const result = (await child.fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief },
			ctxFor(),
		)) as any;
		const lines = (result.message.content as string).split("\n");
		const pins = lines.filter((line) => line.includes('"Style '));
		expect(pins).toHaveLength(2);
		expect(pins.join("\n").length + pins.length).toBeLessThanOrEqual(PINNED_BUDGET);
		expect(result.message.content).not.toContain("Pinned fact");
		expect(lines.at(-1)).toBe('[2 more pinned memories did not fit here; call memory with op "list" to read them.]');
		// The same selection without the kind filter is the main session's: the fact competes for the same budget.
		const all = selectInjection(store, { query: "", scope: "all", seen: new Set(), topK: 3 });
		expect(all?.content.split("\n").at(-1)).toContain("3 more pinned memories");
	});

	it("still ranks a subagent's hits across every kind, beside its pinned preference", async () => {
		const ids = seedPins();
		const child = setup({ isSubagent: true, goal: "deploys tuesdays", recall: "all" });
		const result = (await child.fire(
			"before_agent_start",
			{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief },
			ctxFor(),
		)) as any;
		// The pinned fact arrives as a relevant hit for this goal, not as a pin.
		expect(result.message.details.ids).toEqual([ids.preference, ids.fact]);
	});

	it("gives a lean child no memory notes: its automatic-memory switch is off", async () => {
		seedPins();
		// A lean child's process is started with `OCTOCODE_MEMORY_AUTO=0` (asserted in subagent-tiers.test.ts).
		vi.stubEnv("OCTOCODE_MEMORY_AUTO", "0");
		const lean = setup({ isSubagent: true, goal: "deploys tuesdays", recall: "all" });
		expect(
			await lean.fire(
				"before_agent_start",
				{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt: brief },
				ctxFor(),
			),
		).toBeUndefined();
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
		await store.markUsed([old.id, fresh.id]);
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
		// Pick the memory, choose Delete, confirm it, then dismiss the list it returns to.
		Object.assign(ctx.ui, {
			select: async (title: string, options: string[]) => {
				titles.push(title);
				if (titles.length === 1) return options.find((option) => option.includes("Unused note"));
				return titles.length <= 3 ? "Delete" : undefined;
			},
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

	it("ranks a memory nobody used for long below an equal one in use, and keeps a pinned one up", async () => {
		const store = memoryStore(cwd);
		const old = Date.now() - 100 * DAY_MS;
		const add = (title: string, body: string, pinned = false) =>
			store.set({ title, body: `parser ${body}`, author: "agent", pinned }, old).memory;
		const unused = add("first entry", "tokens split on commas before lookup");
		const used = add("second thing", "errors recover at statement ends always");
		const pinned = add("third item", "grammar tables generated during builds nightly", true);
		await store.markUsed([used.id]);
		const ids = store.search("parser").map((hit) => hit.id);
		expect(ids).toHaveLength(3);
		expect(ids.indexOf(used.id)).toBeLessThan(ids.indexOf(unused.id));
		expect(ids.indexOf(pinned.id)).toBeLessThan(ids.indexOf(unused.id));
	});
});
