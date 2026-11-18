import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeatureSetup } from "../../src/core/features/index.ts";
import { awaitsAnswer } from "../../src/octocode/awaits-answer.ts";
import { registerCompaction } from "../../src/octocode/compaction/register.ts";
import type { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { runningWorkOf } from "../../src/octocode/shared/running-work.ts";
import { asSetup } from "./fake-host.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const MINUTE = 60_000;
const model = {
	provider: "anthropic",
	id: "claude-test",
	api: "anthropic-messages",
	promptCache: { short: 300, long: 3600 },
};

afterEach(() => vi.restoreAllMocks());

let seq = 0;
const message = (role: string, at: number, extra: Record<string, unknown> = {}) => ({
	type: "message",
	id: `m${++seq}`,
	message: { role, timestamp: at, content: [], usage: { cacheRead: 1000, cacheWrite: 10 }, ...extra },
});
const answer = (at: number, text = "done. Finished.") =>
	message("assistant", at, { stopReason: "stop", content: [{ type: "text", text }] });
const warm = (at: number) => ({
	type: "usage",
	id: `w${++seq}`,
	kind: "cache_warm",
	timestamp: new Date(at).toISOString(),
	usage: { cacheRead: 1000, cacheWrite: 0 },
});

/** The real compaction feature, its `cache_warming_decision` handler and the session's running-work view. */
function setup(options: { isSubagent?: boolean; asks?: number } = {}) {
	const handlers = new Map<string, Handler>();
	const api = asSetup({
		on: (name: string, handler: Handler) => {
			handlers.set(name, handler);
			return undefined;
		},
		registerProvider: vi.fn(),
		getSettings: () => ({}),
		getThinkingLevel: () => "off",
	}) as unknown as FeatureSetup;
	const asks = { count: options.asks ?? 0 };
	registerCompaction(
		api,
		{ restore: vi.fn(), forget: vi.fn() } as unknown as FileGuard,
		options.isSubagent ?? false,
		undefined,
		awaitsAnswer(options.isSubagent ?? false, () => asks.count),
	);
	const decide = handlers.get("cache_warming_decision")!;
	return {
		work: runningWorkOf(api),
		asks,
		/** The action taken for an idle refresh core priced at `warmCost` against a `missCost` rewrite and proposed to stop. */
		decide: async (branch: unknown[], hasUI: boolean, warmCost = 0.1, missCost = 1, continuationProbability = 0.15) =>
			(
				(await decide(
					{ type: "cache_warming_decision", action: "stop", warmCost, missCost, continuationProbability },
					{
						hasUI,
						model,
						modelRegistry: {
							find: () => model,
							getAll: () => [model],
							getCachePolicy: () => ({ options: { cacheRetention: "short" } }),
						},
						sessionManager: { getSessionId: () => "s", getBranch: () => branch },
					},
				)) as { action?: string } | undefined
			)?.action ?? "stop (kept)",
	};
}

describe("idle cache warming while the session waits for work it started", () => {
	const now = Date.now();

	it("keeps a headless coordinator's cache warm while a child, a bash job or a timer runs, and stops once nothing does", async () => {
		const host = setup();
		const branch = [message("user", now - 3 * MINUTE), answer(now - 3 * MINUTE)];
		expect(await host.decide(branch, false)).toBe("stop (kept)");
		for (const kind of ["agent", "bash", "timer"] as const) {
			host.work.set(kind, [{ kind, id: `${kind}-1`, title: "running" }]);
			expect(await host.decide(branch, false), kind).toBe("warm");
			host.work.set(kind, []);
		}
		host.work.setBackground(["child"]);
		expect(await host.decide(branch, false)).toBe("warm");
		host.work.setBackground([]);
		expect(await host.decide(branch, false)).toBe("stop (kept)");
	});

	it("warms an interactive coordinator past what a 15% return chance pays, while a child runs", async () => {
		const host = setup();
		const branch = [message("user", now - 3 * MINUTE), answer(now - 3 * MINUTE)];
		// 0.15 × $1 does not repay a $0.30 refresh: the warmer's own decision (stop) stands without a wait.
		expect(await host.decide(branch, true, 0.3)).toBe("stop (kept)");
		host.work.set("agent", [{ kind: "agent", id: "child", title: "implementer" }]);
		expect(await host.decide(branch, true, 0.3)).toBe("warm");
	});

	it("bounds a wait's refreshes: they stop once one more would cost more than the rewrite it saves", async () => {
		const host = setup();
		host.work.set("agent", [{ kind: "agent", id: "child", title: "implementer" }]);
		const branch: unknown[] = [message("user", now - 30 * MINUTE), answer(now - 30 * MINUTE)];
		// $0.30 refreshes against a $1 rewrite: three are worth it, a fourth is not.
		for (let index = 0; index < 3; index++) {
			expect(await host.decide(branch, false, 0.3), `refresh ${index + 1}`).toBe("warm");
			branch.push(warm(now - (25 - 5 * index) * MINUTE));
		}
		expect(await host.decide(branch, false, 0.3)).toBe("stop (kept)");
		// A new reply starts a new wait with the full allowance.
		branch.push(message("user", now - MINUTE), answer(now - MINUTE));
		expect(await host.decide(branch, false, 0.3)).toBe("warm");
	});

	it("warms while a question sent with replyRequired is unanswered", async () => {
		const host = setup({ asks: 1 });
		const branch = [message("user", now - 3 * MINUTE), answer(now - 3 * MINUTE)];
		expect(await host.decide(branch, false)).toBe("warm");
		host.asks.count = 0;
		expect(await host.decide(branch, false)).toBe("stop (kept)");
	});

	it("leaves a refresh during a running agent to the warmer, wait or not", async () => {
		const host = setup();
		host.work.set("bash", [{ kind: "bash", id: "bash-1", title: "build" }]);
		expect(await host.decide([answer(now)], false, 2, 1, 1)).toBe("stop (kept)");
	});
});

describe("idle cache warming of a settled subagent", () => {
	const now = Date.now();

	it("keeps a child's cache warm while its answer reports blocked and waits for its coordinator", async () => {
		const host = setup({ isSubagent: true });
		const blocked = [message("user", now - 2 * MINUTE), answer(now - 2 * MINUTE, "blocked. Which provider?")];
		expect(await host.decide(blocked, true)).toBe("warm");
		const done = [message("user", now - 2 * MINUTE), answer(now - 2 * MINUTE, "done. Shipped.")];
		expect(await host.decide(done, true)).toBe("stop (kept)");
	});

	it("judges a settled child's gaps ended by its coordinator's mail, not only by prompts", async () => {
		const host = setup({ isSubagent: true });
		// Five earlier waits, each ended 3 minutes after the answer by a reply to mail (no user prompt in between).
		const branch: unknown[] = [message("user", now - 200 * MINUTE)];
		for (let index = 0; index < 5; index++) {
			const at = now - (180 - 30 * index) * MINUTE;
			branch.push(answer(at), message("assistant", at + 3 * MINUTE, { stopReason: "toolUse" }));
		}
		// Idle 1 minute: every earlier wait ended within the lifetime, after the entry would have needed a refresh.
		expect(await host.decide([...branch, answer(now - MINUTE)], true)).toBe("warm");
		// Idle 10 minutes: none of those waits lasted that long, so no mail is expected within the lifetime.
		expect(await host.decide([...branch, answer(now - 10 * MINUTE)], true)).toBe("stop (kept)");
	});
});
