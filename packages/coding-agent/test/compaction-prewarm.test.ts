import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { CompactionPrewarm, prewarmLeadTokens } from "../src/core/agent-session/compaction-prewarm.ts";
import { providerCooldowns } from "../src/core/model-runtime/provider-cooldown.ts";
import type { SessionCompactPrewarmEvent } from "../src/core/features/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { prepareCompaction } from "../src/core/compaction/index.ts";

const model = { provider: "p", id: "m", contextWindow: 100_000 } as never;
const settings = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 };
const policy = { watch: (stream: never) => stream, retry: {} as never, callbacks: {} };
const threshold = Math.ceil(0.95 * (100_000 - settings.reserveTokens));

function setup(handlers = true) {
	const manager = SessionManager.inMemory();
	const turn = (text: string) => {
		manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
		manager.appendMessage(fauxAssistantMessage(`answer to ${text.slice(0, 8)}`));
	};
	for (let i = 0; i < 4; i++) turn(`question ${i} ${"x".repeat(4_000)}`);
	const events: SessionCompactPrewarmEvent[] = [];
	const runner = {
		hasHandlers: () => handlers,
		emit: async (event: SessionCompactPrewarmEvent) => void events.push(event),
	} as never;
	const prewarm = new CompactionPrewarm();
	const start = () => prewarm.start(manager, runner, model, settings, policy);
	const take = (target = model, with_ = settings) =>
		prewarm.take(manager.getBranch(), manager.getSessionId(), target, with_);
	return { manager, turn, events, prewarm, start, take };
}

describe("compaction prewarm", () => {
	it("is due only inside the lead before the threshold, and only while compaction is on", () => {
		const { prewarm } = setup();
		const lead = prewarmLeadTokens(100_000);
		expect(prewarm.due(threshold - lead - 1, model, settings)).toBe(false);
		expect(prewarm.due(threshold - lead, model, settings)).toBe(true);
		expect(prewarm.due(threshold - 1, model, settings)).toBe(true);
		// Past the threshold the compaction itself runs.
		expect(prewarm.due(threshold, model, settings)).toBe(false);
		expect(prewarm.due(threshold - 1, model, { ...settings, enabled: false })).toBe(false);
		expect(prewarm.due(threshold - 1, { provider: "p", id: "m", contextWindow: 0 } as never, settings)).toBe(false);
	});

	it("plans ahead of the compaction boundary on a large window, including a configured earlier trigger", () => {
		const { prewarm } = setup();
		const large = { provider: "p", id: "large", contextWindow: 1_000_000 } as never;
		for (const triggerTokens of [999_000, 300_000]) {
			const policy = { ...settings, triggerTokens };
			const stop = Math.ceil(0.95 * triggerTokens);
			expect(prewarm.due(stop - 10_000, large, policy)).toBe(true);
			expect(prewarm.due(stop, large, policy)).toBe(false);
			expect(prewarm.due(triggerTokens - 1, large, policy)).toBe(false);
		}
	});

	it("tells extensions the plan once and hands the same preparation to the compaction after the branch grew", () => {
		const { events, start, take, turn, prewarm } = setup();
		start();
		start();
		expect(events).toHaveLength(1);
		expect(events[0].signal.aborted).toBe(false);
		turn("added while the summary is written");
		expect(take()).toBe(events[0].preparation);
		// A plan was made: none is due again until a compaction succeeds.
		expect(prewarm.due(threshold - 1, model, settings)).toBe(false);
		prewarm.reset();
		expect(events[0].signal.aborted).toBe(true);
		expect(prewarm.due(threshold - 1, model, settings)).toBe(true);
	});

	it("plans nothing while the model's provider cools down from a rate limit, and plans once it is over", () => {
		const { events, prewarm, manager } = setup();
		const cooling = { provider: "prewarm-cooling", id: "m", contextWindow: 100_000 } as never;
		const runner = { hasHandlers: () => true, emit: async (event: never) => void events.push(event) } as never;
		providerCooldowns.record("prewarm-cooling", { retryAfterMs: 60_000 });
		prewarm.start(manager, runner, cooling, settings, policy);
		expect(events).toHaveLength(0);
		expect(prewarm.due(threshold - 1, cooling, settings)).toBe(true);
		const later = Date.now() + 61_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(later);
		try {
			prewarm.start(manager, runner, cooling, settings, policy);
		} finally {
			clock.mockRestore();
		}
		expect(events).toHaveLength(1);
	});

	it("drops the plan, aborting its request, when the model or the settings changed", () => {
		for (const change of ["model", "settings"] as const) {
			const { events, start, take } = setup();
			start();
			const taken =
				change === "model"
					? take({ provider: "p", id: "other", contextWindow: 100_000 } as never)
					: take(model, { ...settings, keepRecentTokens: 100 });
			expect(taken).toBeUndefined();
			expect(events[0].signal.aborted).toBe(true);
			expect(take()).toBeUndefined();
		}
	});

	it("drops the plan when a compaction already followed it or the branch no longer holds its leaf", () => {
		const followed = setup();
		followed.start();
		const kept = followed.events[0].preparation.firstKeptEntryId;
		followed.manager.appendCompaction("Checkpoint", kept, 1_000);
		expect(followed.take()).toBeUndefined();

		const moved = setup();
		moved.start();
		expect(moved.prewarm.take([], moved.manager.getSessionId(), model, settings)).toBeUndefined();
		expect(moved.events[0].signal.aborted).toBe(true);
	});

	it("drops the plan when the transient request instructions changed", () => {
		const { manager, prewarm, events } = setup();
		const runner = {
			hasHandlers: () => true,
			emit: async (event: SessionCompactPrewarmEvent) => void events.push(event),
		} as never;
		prewarm.start(manager, runner, model, settings, { ...policy, forceSystemPrompt: "First instructions" });
		expect(
			prewarm.take(manager.getBranch(), manager.getSessionId(), model, settings, "Different instructions"),
		).toBeUndefined();
		expect(events[0].signal.aborted).toBe(true);
	});

	it("reuses the planned summary when a 429 received after planning is omitted for a retry", () => {
		const { events, start, take, manager, prewarm } = setup();
		start();
		const id = manager.appendMessage({
			...fauxAssistantMessage(""),
			stopReason: "error",
			errorMessage: "429 Too many requests",
		});
		manager.appendContextEdit(id, null);
		prewarm.dropIfStale(model, settings, undefined, manager);
		expect(take()).toBe(events[0].preparation);
		expect(events[0].signal.aborted).toBe(false);
	});

	it.each(["replace", "omit"] as const)("drops a plan when a later context edit %ss a summarized message", (kind) => {
		const { events, start, take, manager } = setup();
		start();
		const target = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
		manager.appendContextEdit(target.id, kind === "omit" ? null : { content: "revised compaction input" });
		expect(take()).toBeUndefined();
		expect(events[0].signal.aborted).toBe(true);
		const fresh = prepareCompaction(manager.getBranch(), settings)!;
		const text = JSON.stringify(fresh.messagesToSummarize);
		expect(text).not.toContain("question 0");
		if (kind === "replace") expect(text).toContain("revised compaction input");
	});

	it("makes no plan without a handler for it, or when nothing can be summarized", () => {
		const unhandled = setup(false);
		unhandled.start();
		expect(unhandled.events).toHaveLength(0);
		expect(unhandled.take()).toBeUndefined();

		const empty = new CompactionPrewarm();
		const events: unknown[] = [];
		const runner = { hasHandlers: () => true, emit: async (event: unknown) => void events.push(event) } as never;
		empty.start(SessionManager.inMemory(), runner, model, settings, policy);
		expect(events).toHaveLength(0);
		// Nothing was requested, so the next approach may still plan.
		expect(empty.due(threshold - 1, model, settings)).toBe(true);
	});
});
