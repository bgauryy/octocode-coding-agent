/**
 * Who paid for each spend is stored on its entry when it is appended and read back by every surface through one
 * function (`entryBilling`): the footer's `Σ`, the web's spend split, `subagents.maxCost` and `/usage` (N5).
 */
import path from "node:path";
import type { Usage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageDailyRow } from "../../../db/src/api.ts";
import { UsageTally } from "../../src/core/application/service/usage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { billingFacts, entryBilling, meteredCost, runBilling } from "../../src/core/usage-totals.ts";
import { refuseOverLimit } from "../../src/octocode/subagents/spawn-limits.ts";
import { reportFacts } from "../../src/octocode/subagents/tracking.ts";
import { registerFooter } from "../../src/octocode/ui/footer.ts";
import { registerUsageRecording } from "../../src/octocode/usage/record.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

vi.mock("../../src/octocode/ui/footer/github.ts", () => ({
	githubTokenPresent: () => false,
	resetGithubToken: () => undefined,
}));

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

const usage = (total: number): Usage => ({
	input: 100,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 110,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const assistant = (provider: string, total: number) =>
	({
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "anthropic-messages",
		provider,
		model: "m",
		usage: usage(total),
		stopReason: "stop",
		timestamp: Date.now(),
	}) as never;

/** The providers a plan pays for right now; the test changes them as a user changing credentials would. */
let plans = new Set<string>();
const registry = () => ({
	getProviderBilling: (provider: string) => (plans.has(provider) ? ("plan" as const) : ("metered" as const)),
});

let stop: () => void = () => undefined;
afterEach(() => stop());

/** A saved session recording its spend, on `anthropic/opus`. */
async function recordedSession() {
	const cwd = tmp("usage-billing-");
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const posted: UsageDailyRow[] = [];
	const f = fakeHost();
	stop = registerUsageRecording(f.api, { post: async (rows) => void posted.push(...rows) });
	const ctx = fakeCtx({ cwd });
	Object.assign(ctx, { sessionManager: manager, model: { provider: "anthropic", id: "opus" } });
	Object.assign(ctx.modelRegistry, registry());
	await f.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
	return { manager, posted, ctx, end: () => f.emit("agent_end", { type: "agent_end", messages: [] }, ctx) };
}

describe("who paid, stored when the spend is written", () => {
	it("is read the same by the footer, /web, maxCost and /usage, also after the credentials change", async () => {
		// Anthropic is signed in with a plan, OpenAI with a metered key.
		plans = new Set(["anthropic"]);
		const { manager, posted, ctx, end } = await recordedSession();
		manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
		manager.appendMessage(assistant("anthropic", 1));
		manager.appendMessage(assistant("openai", 0.5));
		manager.appendUsage("cache_warm", "anthropic", "m", usage(0.25));
		// A foreground child planned on the plan, then switched to the metered provider (`ran`).
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "agent",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 2,
			details: { id: "fg", model: "anthropic/opus", ran: { model: "openai/gpt" } },
			usage: usage(2),
		} as never);
		// A background child that fell back the same way: its report keeps where it ran.
		const run = {
			id: "bg",
			startedAt: 1,
			model: "anthropic/opus:medium",
			ran: {
				model: "openai/gpt",
				fallback: { from: "anthropic/opus", to: "openai/gpt", reason: "hit a usage limit", billingChanged: true },
			},
		};
		manager.appendCustomMessageEntry("octocode-agent-result", "done", true, {
			...reportFacts(run as never),
			usage: usage(7.5),
		});
		await end();
		expect(manager.getEntries().map((entry) => entry.billing)).toEqual([
			undefined,
			"plan",
			"metered",
			"plan",
			"metered",
			"metered",
		]);

		// The user now signs Anthropic in with a key and OpenAI with a plan: what was spent keeps who paid then.
		plans = new Set(["openai"]);
		const facts = billingFacts(ctx);
		const entries = manager.getEntries();

		const web = new UsageTally().read({ sessionManager: manager, modelRuntime: registry(), model: ctx.model } as never);
		expect(web).toMatchObject({ metered: 10, planEstimate: 1.25 });

		expect(entries.reduce((sum, entry) => sum + meteredCost(entry, facts), 0)).toBe(10);
		const f = fakeHost();
		vi.spyOn(f.api.settings, "get").mockReturnValue({ subagents: { maxCost: 9 } });
		expect(() => refuseOverLimit(f.api, ctx, { running: new Map(), live: new Map() })).toThrow(
			/spent \$10\.00, and subagents\.maxCost is \$9\.00/,
		);

		const footer = fakeHost();
		registerFooter(footer.api);
		await footer.emit("session_start", {}, ctx);
		const data = {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		};
		type Footer = (tui: object, paint: unknown, footerData: object) => { render(width: number): string[] };
		const component = (ctx.ui as unknown as { footer: Footer }).footer({ requestRender: () => undefined }, theme, data);
		expect(component.render(200).join("\n")).toMatch(/Σ ≈\$10\.00 · ~\$1\.25 plan/);

		// `/usage` filed the session's own requests (a child records its own) by the same stored billing.
		const daily = (billing: string) =>
			posted.filter((row) => row.billing === billing).reduce((sum, row) => sum + row.cost, 0);
		expect(daily("plan")).toBeCloseTo(1.25);
		expect(daily("metered")).toBeCloseTo(0.5);
		for (const entry of entries.filter((each) => each.type === "usage" || each.type === "message"))
			if (entry.billing) expect(entryBilling(entry, facts)).toBe(entry.billing);
	});

	it("keeps a child's fallback billing in its background report", () => {
		const facts = {
			billingOf: (provider: string) => (provider === "anthropic" ? "plan" : "metered") as never,
			provider: "anthropic",
		};
		const details = {
			id: "w1",
			runId: "r1",
			startedAt: 1,
			model: "anthropic/sonnet:medium",
			ran: {
				model: "openai/gpt-5",
				fallback: { from: "anthropic/sonnet", to: "openai/gpt-5", reason: "hit a usage limit", billingChanged: true },
			},
		} as never;
		expect(runBilling(details, facts)).toBe("metered");
		const report = {
			type: "custom_message",
			customType: "octocode-agent-result",
			details: { ...reportFacts(details), usage: usage(7.5) },
		} as never;
		expect(meteredCost(report, facts)).toBe(7.5);
	});

	it("judges an entry written before billing was stored by its provider now", () => {
		plans = new Set(["anthropic"]);
		const facts = billingFacts({ modelRegistry: registry(), model: { provider: "anthropic" } });
		const old = { type: "message", message: { role: "assistant", provider: "anthropic", usage: usage(1) } } as never;
		expect(entryBilling(old, facts)).toBe("plan");
		expect(entryBilling({ ...(old as object), billing: "metered" } as never, facts)).toBe("metered");
	});
});
