/** Spend by day (`usage_daily`): the recorder every session runs, and `/usage` (`/cost`) reading it. */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentDb, openDatabase, type UsageDailyRow, usageDaily } from "../../../db/src/api.ts";
import {
	builtinDescription,
	getBuiltinCommand,
	parseSlashCommand,
	reservedCommandNames,
	SLASH_MENU_ORDER,
} from "../../src/core/slash-commands.ts";
import { providerQuotas } from "../../src/core/model-runtime/quota-request.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { registerUsageCommand } from "../../src/octocode/usage/command.ts";
import { localDay, registerUsageRecording } from "../../src/octocode/usage/record.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { captureSpend } from "../../src/core/spend-capture.ts";
import { rewritePrompt } from "../../src/octocode/prompt-optimization/rewrite.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
beforeEach(() => {
	const dir = tmp("usage-daily-");
	agent = openDatabase({
		file: path.join(dir, "agent.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	});
});
let stop: () => void = () => undefined;
afterEach(() => {
	stop();
	agent.close();
});

const usage = (cost: number, input = 100) => ({
	input,
	output: 10,
	cacheRead: 40,
	cacheWrite: 5,
	totalTokens: input + 55,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const reply = (provider: string, model: string, cost: number, spent = usage(cost)) =>
	({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider,
		model,
		usage: spent,
		stopReason: "stop",
		timestamp: Date.now(),
	}) as never;
const user = (text: string) => ({ role: "user", content: text, timestamp: Date.now() }) as never;

/**
 * A recorder on a host where `codex` bills by plan and every other provider per token, and a context for `manager`.
 * Requests reach it as the session store appends them (`core/spend-capture.ts`), not from feature events.
 */
function recorder(
	manager: SessionManager,
	options: {
		now?: () => Date;
		post?: (rows: UsageDailyRow[]) => Promise<void>;
		failed?: (error: unknown) => void;
	} = {},
) {
	const posted: UsageDailyRow[][] = [];
	const f = fakeHost();
	stop = registerUsageRecording(f.api, {
		post:
			options.post ??
			(async (rows) => {
				posted.push(rows);
				usageDaily.add(agent.db, rows);
			}),
		...(options.now ? { now: options.now } : {}),
		...(options.failed ? { failed: options.failed } : {}),
	});
	const ctx = fakeCtx({ cwd: manager.getCwd() });
	Object.assign(ctx, { sessionManager: manager, model: { provider: "anthropic", id: "claude-opus-5-5" } });
	Object.assign(ctx.modelRegistry, {
		getProviderBilling: (provider: string) => (provider === "codex" ? "plan" : "metered"),
	});
	const emit = (event: string, payload: object = {}) => f.emit(event, { type: event, ...payload }, ctx);
	const cost = () => posted.flat().reduce((sum, row) => sum + row.cost, 0);
	return { posted, emit, cost, ctx };
}

const saved = () => {
	const dir = tmp("usage-session-");
	return SessionManager.create(dir, path.join(dir, "sessions"));
};

const key = (row: UsageDailyRow) => `${row.day} ${row.provider}/${row.model} ${row.kind} ${row.billing}`;

describe("the usage_daily recorder", () => {
	it("writes one row per day, provider, model, kind and billing, and sums repeats", async () => {
		let now = new Date(2026, 10, 23, 9, 30);
		// A resumed session: what it recorded before this process is history, not new spend.
		const earlier = saved();
		earlier.appendMessage(user("hi"));
		earlier.appendMessage(reply("anthropic", "claude-opus-5-5", 0));
		earlier.appendUsage("compaction_attempt", "anthropic", "claude-opus-5-5", usage(9));
		const manager = SessionManager.open(earlier.getSessionFile()!, undefined, earlier.getCwd());
		const { posted, emit } = recorder(manager, { now: () => now });
		await emit("session_start", { reason: "resume" });
		manager.appendMessage(reply("anthropic", "claude-opus-5-5", 0.5));
		manager.appendMessage(reply("anthropic", "claude-opus-5-5", 0.25));
		manager.appendMessage(reply("codex", "gpt-6.1", 1.5));
		// A subagent's result carries its run's spend: the child recorded those requests itself.
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "t",
			toolName: "agent",
			content: [],
			isError: false,
			timestamp: 1,
			usage: usage(4),
		} as never);
		manager.appendUsage("compaction_attempt", "anthropic", "claude-opus-5-5", usage(0.1));
		await emit("agent_end", { messages: [] });
		expect(posted).toHaveLength(1);
		expect(posted[0].map(key).sort()).toEqual([
			"2026-11-23 anthropic/claude-opus-5-5 compaction_attempt metered",
			"2026-11-23 anthropic/claude-opus-5-5 reply metered",
			"2026-11-23 codex/gpt-6.1 reply plan",
		]);
		const replies = posted[0].find((row) => row.kind === "reply" && row.provider === "anthropic");
		expect(replies).toMatchObject({ requests: 2, input: 200, output: 20, cacheRead: 80, cacheWrite: 10, cost: 0.75 });

		// The next day's reply is a row of its own; the same day's repeat adds to the row already written.
		manager.appendMessage(reply("anthropic", "claude-opus-5-5", 1));
		now = new Date(2026, 10, 24, 0, 5);
		manager.appendMessage(reply("anthropic", "claude-opus-5-5", 2));
		await emit("agent_end", { messages: [] });
		await emit("session_shutdown", { reason: "quit" });
		expect(posted).toHaveLength(2);
		const totals = (day: string) => usageDaily.totals(agent.db, day, day);
		expect(totals("2026-11-23")).toEqual([
			expect.objectContaining({ provider: "anthropic", billing: "metered", requests: 4, cost: 1.85 }),
			expect.objectContaining({ provider: "codex", billing: "plan", requests: 1, cost: 1.5 }),
		]);
		expect(totals("2026-11-24")).toEqual([expect.objectContaining({ requests: 1, cost: 2 })]);
	});

	it("records nothing for a session that is not saved, or a reply that spent nothing", async () => {
		const unsaved = SessionManager.inMemory(tmp());
		const first = recorder(unsaved);
		await first.emit("session_start", { reason: "new" });
		unsaved.appendMessage(reply("anthropic", "x", 1));
		await first.emit("agent_end", { messages: [] });
		expect(first.posted).toEqual([]);
		const manager = saved();
		const second = recorder(manager);
		await second.emit("session_start", { reason: "new" });
		// An aborted call that reported nothing.
		manager.appendMessage(
			reply("anthropic", "x", 0, { ...usage(0), input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
		);
		await second.emit("agent_end", { messages: [] });
		expect(second.posted).toEqual([]);
	});

	it("counts a request once when another process writes the same session", async () => {
		const a = saved();
		a.appendMessage(user("hi"));
		a.appendMessage(reply("anthropic", "m", 0));
		const b = SessionManager.open(a.getSessionFile()!, undefined, a.getCwd());
		const { emit, cost } = recorder(b);
		await emit("session_start", { reason: "resume" });
		// One process pays for a cache refresh; the other's next write merges that entry in.
		a.appendUsage("cache_warm", "anthropic", "m", usage(1));
		b.appendMessage(user("from b"));
		expect(b.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1);
		await emit("agent_end", { messages: [] });
		expect(cost()).toBeCloseTo(1);
	});

	it("records branch and compaction summaries under the session's model", async () => {
		const manager = saved();
		const first = manager.appendMessage(user("hi"));
		manager.appendMessage(reply("anthropic", "claude-opus-5-5", 0));
		const { posted, emit } = recorder(manager);
		await emit("session_start", { reason: "startup" });
		manager.branchWithSummary(first, "summary", {}, false, usage(3));
		const kept = manager.appendMessage(user("next"));
		manager.appendCompaction("summary", kept, 1000, undefined, true, usage(0.5));
		await emit("session_shutdown", { reason: "quit" });
		expect(posted.flat().map((row) => [key(row).split(" ").slice(1).join(" "), row.cost])).toEqual([
			["anthropic/claude-opus-5-5 branch_summary metered", 3],
			["anthropic/claude-opus-5-5 compaction metered", 0.5],
		]);
	});

	it("records a late receipt written to a session this one replaced", async () => {
		const manager = saved();
		manager.appendMessage(user("hi"));
		manager.appendMessage(reply("anthropic", "m", 0));
		const old = manager.getSessionFile()!;
		const { emit, cost } = recorder(manager);
		await emit("session_start", { reason: "startup" });
		const late = manager.captureUsageWriter();
		await emit("session_shutdown", { reason: "new" });
		manager.newSession();
		await emit("session_start", { reason: "new" });
		late("cache_warm", "anthropic", "m", usage(5));
		await emit("agent_end", { messages: [] });
		expect(cost()).toBe(5);
		// It is in the session that asked for it, not the new one.
		const reopened = SessionManager.open(old, undefined, manager.getCwd());
		expect(reopened.getEntries().filter((entry) => entry.type === "usage")).toEqual([
			expect.objectContaining({ kind: "cache_warm", billing: "metered" }),
		]);
		expect(manager.getEntries().filter((entry) => entry.type === "usage")).toEqual([]);
	});

	it("records the helper calls and runner turns no session entry carries", async () => {
		const manager = saved();
		const { posted, emit } = recorder(manager);
		await emit("session_start", { reason: "startup" });
		const model = {
			provider: "p",
			id: "tiny",
			api: "faux",
			cost: { input: 1, output: 1 },
			contextWindow: 200_000,
			input: ["text"],
		};
		const ctx = {
			cwd: manager.getCwd(),
			model,
			modelRegistry: { getAvailable: () => [model], getApiKeyAndHeaders: async () => ({ ok: true }) },
		};
		const answer = async () =>
			({ ...(reply("p", "tiny", 0.02) as object), content: [{ type: "text", text: "Fix the login loop" }] }) as never;
		expect(await rewritePrompt(ctx as never, "fix login", new AbortController().signal, answer)).toEqual({
			text: "Fix the login loop",
			model: "p/tiny",
		});
		captureSpend({
			cwd: manager.getCwd(),
			kind: "runner",
			provider: "claude-code",
			model: "sonnet",
			usage: usage(0),
			billing: "plan",
		});
		captureSpend({ cwd: manager.getCwd(), kind: "runner", provider: "codex-cli", model: "gpt", usage: usage(0.3) });
		await emit("agent_end", { messages: [] });
		expect(
			posted
				.flat()
				.map(key)
				.map((line) => line.split(" ").slice(1).join(" "))
				.sort(),
		).toEqual(["claude-code/sonnet runner plan", "codex-cli/gpt runner metered", "p/tiny prompt_rewrite metered"]);
	});

	it("keeps the rows of a failed write for the next flush and says so once", async () => {
		const manager = saved();
		let busy = true;
		const written: UsageDailyRow[] = [];
		const failures: unknown[] = [];
		const { emit } = recorder(manager, {
			post: async (rows) => {
				if (busy) throw new Error("database is locked");
				written.push(...rows);
			},
			failed: (error) => failures.push(error),
		});
		await emit("session_start", { reason: "startup" });
		manager.appendMessage(reply("anthropic", "m", 1));
		await expect(emit("agent_end", { messages: [] })).resolves.toBeDefined();
		manager.appendMessage(reply("anthropic", "m", 2));
		await emit("agent_end", { messages: [] });
		expect(failures).toEqual([new Error("database is locked")]);
		busy = false;
		await emit("session_shutdown", { reason: "quit" });
		expect(written).toEqual([expect.objectContaining({ requests: 2, cost: 3 })]);
	});

	it("files a request under its local day", () => {
		expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
	});
});

describe("/usage", () => {
	const row = (day: string, provider: string, model: string, billing: "plan" | "metered", cost: number) => ({
		day,
		workspaceId: "w1",
		provider,
		model,
		kind: "reply",
		billing,
		requests: 2,
		input: 1_000,
		output: 200,
		cacheRead: 3_000,
		cacheWrite: 0,
		cost,
		unpriced: 0,
	});
	const run = async (typed: string) => {
		const commands = new Subcommands();
		registerUsageCommand(commands, {
			source: () => ({
				totals: (from, to) => usageDaily.totals(agent.db, from, to),
				firstDay: () => usageDaily.firstDay(agent.db),
			}),
			now: () => new Date(2026, 10, 23, 12),
		});
		const parsed = parseSlashCommand(typed)!;
		const ctx = fakeCtx({ cwd: "/work" });
		await commands.get(parsed.name)!.handler(parsed.args, ctx);
		return { parsed, notes: ctx.ui.notes, commands };
	};

	it("is a built-in word that /cost runs, in the menu after /status", () => {
		expect(getBuiltinCommand("usage")).toMatchObject({ requiresNative: true, argumentValues: ["today", "7d", "30d"] });
		expect(SLASH_MENU_ORDER.indexOf("usage")).toBe(SLASH_MENU_ORDER.indexOf("status") + 1);
		expect(SLASH_MENU_ORDER).not.toContain("cost");
		expect(reservedCommandNames([]).has("cost")).toBe(true);
	});

	it("/cost 7d opens /usage with a row per provider and model and a split total (RFC V9)", async () => {
		usageDaily.add(agent.db, [
			row("2026-11-21", "anthropic", "claude-opus-5-5", "metered", 0.74),
			row("2026-11-22", "anthropic", "claude-sonnet-5", "metered", 0.5),
			row("2026-11-22", "openai-codex", "gpt-6.1", "plan", 1.1),
			row("2026-11-23", "openai-codex", "gpt-6.1", "plan", 2),
			// Outside the 7 days: not counted.
			row("2026-11-10", "anthropic", "claude-opus-5-5", "metered", 50),
		]);
		const { parsed, notes, commands } = await run("/cost 7d");
		expect(parsed).toEqual({ name: "usage", args: "7d" });
		expect(commands.get("usage")?.description).toBe(builtinDescription("usage"));
		expect(notes).toHaveLength(1);
		const text = notes[0].message;
		expect(text).toContain("Usage last 7 days (2026-11-17 – 2026-11-23)");
		const lines = text.split("\n");
		const line = (name: string) => lines.find((entry) => entry.trimStart().startsWith(name)) ?? "";
		expect(line("anthropic").trim()).toBe("anthropic");
		expect(line("claude-opus-5-5")).toMatch(/claude-opus-5-5\s+2\s+↑1k \+3k cached ↓200\s+≈\$0\.74$/);
		expect(line("claude-sonnet-5")).toMatch(/≈\$0\.50$/);
		expect(line("openai-codex").trim()).toBe("openai-codex");
		// A plan's requests show as an estimate in its own column, never as money.
		expect(line("gpt-6.1")).toMatch(/gpt-6\.1\s+4\s+.*\s{3}~\$3\.10$/);
		expect(line("gpt-6.1")).not.toContain("≈$");
		expect(line("Total")).toMatch(/Total\s+8\s+.*≈\$1\.24\s{3}~\$3\.10$/);
		// Recording began before the range: no note.
		expect(text).not.toContain("History starts");
	});

	it("shows today and the last 7 days by default, says where an empty history starts, and refuses other periods", async () => {
		const empty = await run("/usage");
		const none = empty.notes[0].message;
		expect(none).toContain("Usage today (2026-11-23)\n  No usage recorded.\n\nUsage last 7 days");
		// Where history starts is said once for the whole report, not under every empty period; with no table, the
		// note on what the money and plan columns mean has nothing to explain.
		expect(none.match(/History starts at the upgrade that added \/usage/g)).toHaveLength(1);
		expect(none).not.toContain("Money is billed");
		// Recording began within the 7 days: that table says from when.
		usageDaily.add(agent.db, [row("2026-11-22", "anthropic", "claude-opus-5-5", "metered", 1)]);
		const started = (await run("/usage")).notes[0].message;
		expect(started).toContain("Usage today (2026-11-23)\n  No usage recorded.");
		expect(started).not.toContain("History starts at the upgrade");
		expect(started).toContain("Money is billed per token");
		expect(started).toMatch(
			/Usage last 7 days[^]*≈\$1\.00\n {2}History starts 2026-11-22: earlier days were not recorded\./,
		);
		const wrong = await run("/usage yesterday");
		expect(wrong.notes).toEqual([{ message: "Usage: /usage [today|7d|30d]", type: "warning" }]);
	});

	it("lists the quota windows it is given under the tables", async () => {
		const commands = new Subcommands();
		registerUsageCommand(commands, {
			source: () => ({ totals: () => [], firstDay: () => undefined }),
			quota: () => [{ provider: "openai-codex", text: "5h 62% · resets 14:20" }],
		});
		const ctx = fakeCtx({ cwd: "/work" });
		await commands.get("usage")!.handler("today", ctx);
		expect(ctx.ui.notes[0].message).toContain("Quota\n  openai-codex  5h 62% · resets 14:20");
	});

	it("reads the quota store by default: each provider's windows in force, names aligned", async () => {
		const now = Date.now();
		const reading = (provider: string, window: string, label: string, usedFraction: number) => ({
			provider,
			window,
			label,
			usedFraction,
			resetsAt: now + 3_600_000,
			kind: "plan" as const,
			source: "header" as const,
			observedAt: now,
		});
		const all = vi
			.spyOn(providerQuotas, "all")
			.mockReturnValue([
				reading("anthropic", "five_hour", "5h", 0.4),
				reading("openai-codex", "primary", "5h", 0.62),
				reading("openai-codex", "secondary", "week", 0.18),
			]);
		try {
			const commands = new Subcommands();
			registerUsageCommand(commands, { source: () => ({ totals: () => [], firstDay: () => "2026-11-01" }) });
			const ctx = fakeCtx({ cwd: "/work" });
			await commands.get("usage")!.handler("today", ctx);
			expect(ctx.ui.notes[0].message).toMatch(
				/Quota\n {2}anthropic {5}5h 40% · resets \d\d:\d\d\n {2}openai-codex {2}5h 62% · resets \d\d:\d\d · week 18% · resets \d\d:\d\d/,
			);
		} finally {
			all.mockRestore();
		}
	});
});
