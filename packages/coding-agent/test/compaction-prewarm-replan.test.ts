import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { afterEach, describe, expect, it } from "vitest";
import { compactionStopTokens } from "../src/core/compaction/boundary-stop.ts";
import { CompactionPrewarm, prewarmLeadTokens } from "../src/core/agent-session/compaction-prewarm.ts";
import { estimateProjectedContextTokens } from "../src/core/compaction/index.ts";
import type { SessionCompactPrewarmEvent } from "../src/core/features/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const model = { provider: "p", id: "m", contextWindow: 100_000 } as never;
const other = { provider: "p", id: "other", contextWindow: 100_000 } as never;
const settings = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 };
const policy = { watch: (stream: never) => stream, retry: {} as never, callbacks: {} };
// One token short of where the run stops for compaction: inside the prewarm lead.
const nearThreshold = compactionStopTokens(100_000, settings) - 1;

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

	it("can replan immediately after an edit to the input of the active summary", () => {
		const { manager, prewarm, events } = planned();
		const user = manager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user")!;
		manager.appendContextEdit(user.id, { content: "corrected" });
		prewarm.dropIfStale(model, settings, undefined, manager);
		expect(events[0].signal.aborted).toBe(true);
		expect(prewarm.due(nearThreshold, model, settings)).toBe(true);
	});

	it("stays while the branch only grew past it, and ends once the session leaves that branch (a /tree jump)", () => {
		const { manager, prewarm, events } = planned();
		const planLeaf = manager.getLeafId();
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "grown" }], timestamp: 0 });
		prewarm.dropIfStale(model, settings, undefined, manager);
		expect(events[0].signal.aborted).toBe(false);

		// Back to an entry before the plan's: the plan's summary is of a branch the session no longer shows.
		const earlier = manager.getBranch().find((entry) => entry.type === "message")!.id;
		expect(earlier).not.toBe(planLeaf);
		manager.branch(earlier);
		prewarm.dropIfStale(model, settings, undefined, manager);
		expect(events[0].signal.aborted).toBe(true);
		expect(prewarm.due(nearThreshold, model, settings)).toBe(true);
	});
});

/** About `tokens` of context, at the estimator's characters per token. */
const filler = (tokens: number, label: string) => `${label} ${"x".repeat(Math.round(tokens * CHARS_PER_TOKEN))}`;
/** Halfway into the prewarm lead of the default scheduler. */
const IN_THE_LEAD = compactionStopTokens(200_000, settings) - prewarmLeadTokens(200_000) / 2;

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
					api.bus.on("session_compact_prewarm", async (event) => void plans.push(event));
				},
			],
		});
		harnesses.push(harness);
		for (let i = 0; i < 4; i++) {
			manager.appendMessage({ role: "user", content: filler(10_000, `early ${i}`), timestamp: 0 });
			manager.appendMessage(fauxAssistantMessage(`answer ${i}`));
		}
		for (let i = 0; i < 5; i++) {
			manager.appendMessage({
				role: "user",
				content: filler(Math.floor((IN_THE_LEAD - 40_000) / 5), `more ${i}`),
				timestamp: 0,
			});
			manager.appendMessage(fauxAssistantMessage(`answer more ${i}`));
		}
		harness.session.refreshContext();
		return { harness, plans };
	}

	/**
	 * The faux provider reports usage at four characters per token, below the request estimate (`CHARS_PER_TOKEN`): grow
	 * from the measured usage-backed baseline, so the next request is back halfway inside the lead.
	 */
	const growIntoTheLead = (harness: Harness) => {
		const manager = harness.sessionManager;
		const current = estimateProjectedContextTokens(manager.buildSessionProjection(), manager.getBranch()).tokens;
		manager.appendMessage({ role: "user", content: filler(IN_THE_LEAD - current, "growth"), timestamp: 0 });
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
