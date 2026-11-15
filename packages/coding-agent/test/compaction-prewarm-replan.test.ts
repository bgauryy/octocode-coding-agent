import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CompactionPrewarm } from "../src/core/agent-session/compaction-prewarm.ts";
import type { SessionCompactPrewarmEvent } from "../src/core/features/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const model = { provider: "p", id: "m", contextWindow: 100_000 } as never;
const other = { provider: "p", id: "other", contextWindow: 100_000 } as never;
const settings = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 };
const policy = { watch: (stream: never) => stream, retry: {} as never, callbacks: {} };
const nearThreshold = 100_000 - settings.reserveTokens - 1;

function planned() {
	const manager = SessionManager.inMemory();
	for (let i = 0; i < 4; i++) {
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `q${i} ${"x".repeat(4_000)}` }],
			timestamp: 0,
		});
		manager.appendMessage(fauxAssistantMessage(`a${i}`));
	}
	const events: SessionCompactPrewarmEvent[] = [];
	const runner = {
		hasHandlers: () => true,
		emit: async (event: SessionCompactPrewarmEvent) => void events.push(event),
	} as never;
	const prewarm = new CompactionPrewarm();
	prewarm.start(manager, runner, model, settings, policy);
	return { manager, prewarm, events };
}

describe("a prewarm plan that was dropped", () => {
	it("is planned again at the next approach to the threshold", () => {
		const staleModel = planned();
		expect(
			staleModel.prewarm.take(staleModel.manager.getBranch(), staleModel.manager.getSessionId(), other, settings),
		).toBeUndefined();
		expect(staleModel.events[0].signal.aborted).toBe(true);
		expect(staleModel.prewarm.due(nearThreshold, other, settings)).toBe(true);

		const aborted = planned();
		aborted.prewarm.drop();
		expect(aborted.events[0].signal.aborted).toBe(true);
		expect(aborted.prewarm.due(nearThreshold, model, settings)).toBe(true);
	});

	it("is replaced at once when the model it was made for is no longer the one in use", () => {
		const { prewarm, events } = planned();
		expect(prewarm.due(nearThreshold, other, settings)).toBe(false);
		prewarm.dropIfStale(other, settings);
		expect(events[0].signal.aborted).toBe(true);
		expect(prewarm.due(nearThreshold, other, settings)).toBe(true);
	});

	it("stays while the model and settings it was made for are still in use", () => {
		const { prewarm, events } = planned();
		prewarm.dropIfStale(model, settings);
		expect(events[0].signal.aborted).toBe(false);
		expect(prewarm.due(nearThreshold, model, settings)).toBe(false);
	});
});

/** About `tokens` of context: the estimate counts three characters a token. */
const filler = (tokens: number, label: string) => `${label} ${"x".repeat(tokens * 3)}`;

describe("the session's prewarm", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function sessionInTheLead() {
		const manager = SessionManager.inMemory();
		const plans: SessionCompactPrewarmEvent[] = [];
		const harness = await createHarness({
			sessionManager: manager,
			models: [
				{ id: "window-200k", contextWindow: 200_000 },
				{ id: "other-200k", contextWindow: 200_000 },
			],
			tools: [],
			compactionPolicy: { reserveTokens: 1_000, keepRecentTokens: 500 },
			builtinCompactionFactories: [
				(api) => {
					api.on("session_compact_prewarm", async (event) => void plans.push(event));
				},
			],
		});
		harnesses.push(harness);
		for (let i = 0; i < 4; i++) {
			manager.appendMessage({ role: "user", content: filler(10_000, `early ${i}`), timestamp: 0 });
			manager.appendMessage(fauxAssistantMessage(`answer ${i}`));
		}
		for (let i = 0; i < 5; i++) {
			manager.appendMessage({ role: "user", content: filler(31_000, `more ${i}`), timestamp: 0 });
			manager.appendMessage(fauxAssistantMessage(`answer more ${i}`));
		}
		harness.session.refreshContext();
		return { harness, plans };
	}

	/** The faux provider reports usage below the request estimate: the next request is back inside the lead after this. */
	const growIntoTheLead = (harness: Harness) => {
		harness.sessionManager.appendMessage({ role: "user", content: filler(40_000, "growth"), timestamp: 0 });
		harness.session.refreshContext();
	};

	it("plans again for the new model after a model switch, and ends the old plan's request", async () => {
		const { harness, plans } = await sessionInTheLead();
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("one");
		expect(plans).toHaveLength(1);

		await harness.session.setModel(harness.getModel("other-200k")!);
		growIntoTheLead(harness);
		harness.setResponses([fauxAssistantMessage("second")]);
		await harness.session.prompt("two");
		expect(plans[0].signal.aborted).toBe(true);
		expect(plans).toHaveLength(2);
		expect(plans[1].signal.aborted).toBe(false);
	});

	it("plans again after the planned work was cancelled", async () => {
		const { harness, plans } = await sessionInTheLead();
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("one");
		expect(plans).toHaveLength(1);

		harness.session.abortCompaction();
		expect(plans[0].signal.aborted).toBe(true);
		growIntoTheLead(harness);
		harness.setResponses([fauxAssistantMessage("second")]);
		await harness.session.prompt("two");
		expect(plans).toHaveLength(2);
	});
});
