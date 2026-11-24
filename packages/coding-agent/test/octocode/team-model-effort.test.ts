import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { openWidgetLines as widgetLines } from "./two-line-panel.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * `coordinate list` and the `/agents` panel show each agent's route as `provider/id:level`: the effort a reasoning model
 * runs at, from the moment the agent joins and after every model or level change, never `:off` on a model that cannot think.
 */
const OPUS = { provider: "anthropic", id: "claude-opus-5-5", reasoning: true };
const PLAIN = { provider: "openai", id: "gpt-4o", reasoning: false };

function mainAgent(model: typeof OPUS | typeof PLAIN, level: string) {
	const fake = fakeHost();
	const state = { level, model };
	(fake.api.models as { getThinkingLevel: () => string }).getThinkingLevel = () => state.level;
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
	registerCollab(fake.api, team);
	const ctx = fakeCtx({ cwd: tmp(), model });
	const self = () => team.members().find((entry) => entry.id === team.id)!;
	/** The model of the agent's row once it reaches the shared database (activity is written on the next tick). */
	const modelNow = async (expected: string) => {
		await fake.emit("agent_start", {}, ctx);
		await vi.waitFor(() => expect(self().model).toBe(expected));
	};
	return { ...fake, team, ctx, state, self, modelNow };
}

describe("an agent's model in the team row", () => {
	it("names the route and level as soon as the agent joins, before any reply", async () => {
		const a = mainAgent(OPUS, "high");
		await a.emit("session_start", { reason: "startup" }, a.ctx);
		a.team.join();
		await a.modelNow("anthropic/claude-opus-5-5:high");
	});

	it("keeps `:off` for a reasoning model whose thinking is off, and adds nothing for a model that cannot think", async () => {
		const off = mainAgent(OPUS, "off");
		await off.emit("session_start", { reason: "startup" }, off.ctx);
		off.team.join();
		await off.modelNow("anthropic/claude-opus-5-5:off");
		const plain = mainAgent(PLAIN, "off");
		await plain.emit("session_start", { reason: "startup" }, plain.ctx);
		plain.team.join();
		await plain.emit(
			"message_end",
			{
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-4o",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
				},
			},
			plain.ctx,
		);
		await plain.modelNow("openai/gpt-4o");
	});

	it("follows a level change at once, without waiting for the next reply", async () => {
		const a = mainAgent(OPUS, "high");
		await a.emit("session_start", { reason: "startup" }, a.ctx);
		a.team.join();
		a.state.level = "low";
		await a.emit("thinking_level_select", { level: "low", previousLevel: "high" }, a.ctx);
		await a.modelNow("anthropic/claude-opus-5-5:low");
	});

	it("follows a model switch at once, with the level the new model runs at", async () => {
		const a = mainAgent(OPUS, "high");
		await a.emit("session_start", { reason: "startup" }, a.ctx);
		a.team.join();
		a.state.model = PLAIN as never;
		a.state.level = "off";
		(a.ctx as { model: unknown }).model = PLAIN;
		await a.emit("model_select", { model: PLAIN, previousModel: OPUS, source: "set" }, a.ctx);
		await a.modelNow("openai/gpt-4o");
	});

	it("shows a reply's model with the level in force, as before", async () => {
		const a = mainAgent(OPUS, "medium");
		await a.emit("session_start", { reason: "startup" }, a.ctx);
		a.team.join();
		await a.emit(
			"message_end",
			{
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-opus-5-5",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
				},
			},
			a.ctx,
		);
		await a.modelNow("anthropic/claude-opus-5-5:medium");
	});
});

describe("the /agents panel row keeps the effort", () => {
	const NOW = 1_000_000;
	const row = (id: string, model: string, parentId?: string): Member => ({
		id,
		role: "main",
		pid: process.pid,
		status: "idle",
		joinedAt: NOW - 60_000,
		updatedAt: NOW,
		toolCalls: 0,
		input: 0,
		cacheRead: 0,
		output: 0,
		cost: 0,
		unpriced: false,
		model,
		...(parentId ? { parentId } : {}),
	});

	it("keeps the main session's row to its name and shows a child's role and route without its provider, level included", () => {
		const lines = widgetLines(
			[row("salty-squid", "anthropic/claude-opus-5-5:high"), row("inky-kraken", "openai/gpt-5.5:low", "salty-squid")],
			"salty-squid",
			NOW,
			theme,
			150,
		);
		// The root row is its name and light: its model and effort are the footer's. A child's role and full route, level
		// included, are on its detail line, its time at the terminal's edge.
		expect(lines).toEqual([" 🦑 salty-squid ○", " └ ○ inky-kraken", `${"     main · gpt-5.5:low".padEnd(148)}1m`]);
		expect(lines.join("\n")).not.toMatch(/anthropic\/|openai\//);
	});

	it("draws each agent's effort on its detail line: in its model's level, the role alone when unknown, `?` for a runner", () => {
		const child = (id: string, extra: Partial<Member>): Member => ({
			...row(id, "", "salty-squid"),
			role: "implementer",
			...extra,
		});
		const text = widgetLines(
			[
				row("salty-squid", "anthropic/claude-opus-5-5:high"),
				child("inky-kraken", { model: "openai/gpt-5.5:low" }),
				// Held: reserved, no model yet.
				child("held-otter", { model: undefined }),
				// A runner owns its effort: without a model the role says `?`.
				child("pull-crab", { model: undefined, mailbox: "pull" }),
				// A level-like suffix in a runner's model says nothing, and the cell shows `?`.
				child("codex-heron", { model: "codex/gpt-5:high", mailbox: "pull" }),
			],
			"salty-squid",
			NOW,
			theme,
			150,
		);
		// The head row names the agent alone; the line under it says who it is.
		const head = (id: string) => text.find((line) => line.includes(id))!;
		const detail = (id: string) => text[text.findIndex((line) => line.includes(id)) + 1].replace(/ +/g, " ");
		expect(head("inky-kraken")).toBe(" ├ ○ inky-kraken");
		expect(detail("inky-kraken")).toBe(" │ implementer · gpt-5.5:low 1m");
		expect(detail("held-otter")).toBe(" │ implementer 1m");
		expect(detail("pull-crab")).toBe(" │ implementer:? 1m");
		expect(detail("codex-heron")).toContain(" implementer:? ");
	});

	it("cuts a long model id, never its level", () => {
		const lines = widgetLines(
			[
				row("salty-squid", "anthropic/claude-opus-5-5:high"),
				row("inky-kraken", "anthropic/claude-haiku-4-5-20251001-preview-long:medium", "salty-squid"),
			],
			"salty-squid",
			NOW,
			theme,
			150,
		);
		expect(lines.join("\n")).toMatch(/…:medium/);
	});
});
