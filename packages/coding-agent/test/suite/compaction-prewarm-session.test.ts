import { fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { expect, it } from "vitest";
import { type CompactionPreparation, estimateProjectedContextTokens } from "../../src/core/compaction/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sharedSummary } from "../../src/octocode/compaction/shared-summary.ts";
import { createHarness } from "./harness.ts";

/** About `tokens` of context: the estimate counts three characters a token. */
const filler = (tokens: number, label: string) => `${label} ${"x".repeat(tokens * 3)}`;

it("plans the threshold compaction ahead, beside the run, and that compaction runs the same plan", async () => {
	const manager = SessionManager.inMemory();
	const seen: string[] = [];
	let planned: CompactionPreparation | undefined;
	let compacted: CompactionPreparation | undefined;
	const harness = await createHarness({
		sessionManager: manager,
		models: [{ id: "window-200k", contextWindow: 200_000 }],
		tools: [],
		compactionPolicy: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 },
		builtinCompactionFactories: [
			(api) => {
				api.bus.on("session_compact_prewarm", async (event) => {
					seen.push("prewarm");
					planned = event.preparation;
				});
				api.bus.on("session_before_compact", async (event) => {
					seen.push(`compact:${event.reason}`);
					compacted = event.preparation;
					return {
						compaction: {
							summary: "Checkpoint",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	const contextTokens = () =>
		estimateProjectedContextTokens(manager.buildSessionProjection(), manager.getBranch()).tokens;
	try {
		// Far below the lead: a run plans nothing.
		for (let i = 0; i < 4; i++) {
			manager.appendMessage({ role: "user", content: filler(10_000, `early ${i}`), timestamp: 0 });
			manager.appendMessage(fauxAssistantMessage(`answer ${i}`));
		}
		expect(contextTokens()).toBeLessThan(179_000);
		harness.session.refreshContext();
		harness.setResponses([fauxAssistantMessage("still small")]);
		await harness.session.prompt("first");
		expect(seen).toEqual([]);

		// Inside the lead (the threshold is 199,000 tokens, the lead 20,000): the plan is made and the run goes on.
		for (let i = 0; i < 5; i++) {
			manager.appendMessage({ role: "user", content: filler(31_000, `more ${i}`), timestamp: 0 });
			manager.appendMessage(fauxAssistantMessage(`answer more ${i}`));
		}
		expect(contextTokens()).toBeGreaterThan(179_000);
		expect(contextTokens()).toBeLessThan(199_000);
		harness.session.refreshContext();
		harness.setResponses([fauxAssistantMessage("near the threshold")]);
		await harness.session.prompt("second");
		expect(seen).toEqual(["prewarm"]);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);

		// The faux provider reports usage at four characters per token, below the three-character estimate used before
		// the request. Add enough new context to cross the threshold from that usage-backed baseline.
		manager.appendMessage({ role: "user", content: filler(60_000, "over"), timestamp: 0 });
		manager.appendMessage(fauxAssistantMessage("answer over"));
		expect(contextTokens()).toBeGreaterThan(199_000);
		harness.session.refreshContext();
		harness.setResponses([fauxAssistantMessage("after the compaction")]);
		await harness.session.prompt("third");
		expect(seen).toEqual(["prewarm", "compact:threshold"]);
		expect(compacted).toBe(planned);
		const branch = manager.getBranch();
		const at = branch.findIndex((entry) => entry.type === "compaction");
		expect(at).toBeGreaterThan(0);
		const text = JSON.stringify(harness.session.sessionManager.buildSessionProjection().messages);
		expect(text).toContain("over x");
		expect(text).toContain("third");

		// The next approach to the threshold may plan again.
		expect(seen.filter((item) => item === "prewarm")).toHaveLength(1);
	} finally {
		harness.cleanup();
	}
});

it("passes the last successful forced system prefix into the real near-threshold prewarm event", async () => {
	const manager = SessionManager.inMemory();
	const requests: TranscriptContext[] = [];
	let forced: string | undefined;
	let pending: Promise<unknown> | undefined;
	const harness = await createHarness({
		sessionManager: manager,
		models: [{ id: "window-200k", contextWindow: 200_000 }],
		tools: [],
		compactionPolicy: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 },
		builtinCompactionFactories: [
			(api) => {
				api.bus.on("before_agent_start", () => ({ systemPrompt: "Use this exact transient prompt." }));
				api.bus.on("session_compact_prewarm", async (event, ctx) => {
					forced = event.summaryRequest?.forceSystemPrompt;
					pending = sharedSummary(api, event, ctx, ctx.model!, "Preserve the objective.");
					await pending;
				});
			},
		],
	});
	const capture = (context: TranscriptContext) => {
		requests.push(context);
		return fauxAssistantMessage("## Goal\nPreserve the objective.");
	};
	try {
		for (let i = 0; i < 4; i++) {
			manager.appendMessage({ role: "user", content: filler(10_000, `early ${i}`), timestamp: 0 });
			manager.appendMessage(fauxAssistantMessage(`answer ${i}`));
		}
		harness.session.refreshContext();
		harness.setResponses([capture]);
		await harness.session.prompt("first");
		const live = requests[0];
		expect(live.messages[0]).toMatchObject({ role: "system", content: "Use this exact transient prompt." });
		for (let i = 0; i < 5; i++) {
			manager.appendMessage({ role: "user", content: filler(31_000, `more ${i}`), timestamp: 0 });
			manager.appendMessage(fauxAssistantMessage(`answer more ${i}`));
		}
		harness.session.refreshContext();
		harness.setResponses([capture, capture]);
		await harness.session.prompt("second");
		await pending;
		expect(forced).toBe("Use this exact transient prompt.");
		const summary = requests.find((request) =>
			JSON.stringify(request.messages.at(-1)).includes("Stop here and write a context checkpoint"),
		);
		expect(summary).toBeDefined();
		expect(JSON.stringify(summary!.messages.slice(0, live.messages.length))).toBe(JSON.stringify(live.messages));
	} finally {
		harness.cleanup();
	}
});
