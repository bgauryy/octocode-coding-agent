import { type AssistantMessage, fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { estimateContextTokens } from "@octocodeai/octocode-ai/utils/estimate";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function usage(input: number) {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// A 20,000-token window with a 4,000-token reserve: the threshold is 16,000. The model writes at most 100 tokens, so a
// request fits the window up to 19,900.
const WINDOW = 20_000;
const THRESHOLD = 16_000;
const HARD_LIMIT = 19_900;
/** Characters of `tokens` estimated tokens (2.5 characters per token for a model of no known family). */
const chars = (tokens: number) => Math.round(tokens * 2.5);

interface Run {
	harness: Harness;
	/** Estimated tokens and user texts of each request the model answered. */
	requests: Array<{ tokens: number; texts: string[] }>;
	/** Compactions saved (summaries the feature wrote). */
	summaries(): number;
	/** Resolves once a compaction's hook waits for its cancel (with `cancelFirst`). */
	waiting: Promise<void>;
}

/**
 * A session of two turns (about 7,500 and 6,500 tokens, the last response counted at 14,100). The kept tail (6,000
 * tokens) keeps the second turn, so a compaction before a prompt summarizes only the first. Summaries come from a
 * feature, so every model request is a main one. With `cancelFirst`, the first compaction waits until it is cancelled;
 * with `keepMoreFirst`, the feature's first compaction keeps the second turn whatever the plan, as a feature's own
 * result (or what it restores) may keep more than the plan made room for.
 */
async function seededSession(options: { cancelFirst?: boolean; keepMoreFirst?: boolean } = {}): Promise<Run> {
	let attempts = 0;
	let turnTwo = "";
	const waiting = Promise.withResolvers<void>();
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: WINDOW, maxTokens: 100 }],
		tools: [],
		compactionPolicy: { enabled: true, reserveTokens: WINDOW - THRESHOLD, keepRecentTokens: 6_000 },
		builtinCompactionFactories: [
			(api) => {
				api.bus.on("session_before_compact", async (event) => {
					const first = attempts++ === 0;
					if (options.cancelFirst && first) {
						waiting.resolve();
						await new Promise((resolve) => event.signal.addEventListener("abort", resolve, { once: true }));
					}
					return {
						compaction: {
							summary: `summary ${attempts}`,
							firstKeptEntryId: options.keepMoreFirst && first ? turnTwo : event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		],
	});
	harnesses.push(harness);
	const model = harness.getModel();
	const now = Date.now();
	const answer = (text: string, at: number, tokens?: number): AssistantMessage => ({
		...fauxAssistantMessage(text, { timestamp: at }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(tokens ?? 10),
	});
	const user = (text: string, at: number) => ({
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: at,
	});
	harness.sessionManager.appendMessage(user(`turn one ${"a".repeat(chars(7_500))}`, now - 4000));
	harness.sessionManager.appendMessage(answer("one done", now - 3000));
	turnTwo = harness.sessionManager.appendMessage(user(`turn two ${"b".repeat(chars(6_500))}`, now - 2000));
	harness.sessionManager.appendMessage(answer("two done", now - 1000, 14_100));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

	const requests: Run["requests"] = [];
	const record = (context: TranscriptContext) => {
		requests.push({
			tokens: estimateContextTokens(context).tokens,
			texts: context.messages.filter((message) => message.role === "user").map((message) => getMessageText(message)),
		});
		return fauxAssistantMessage("answered");
	};
	harness.setResponses([record, record]);
	const summaries = () => harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
	return { harness, requests, summaries, waiting: waiting.promise };
}

async function promptAfterCompaction(promptTokens: number, options: { keepMoreFirst?: boolean } = {}) {
	const run = await seededSession(options);
	await run.harness.session.prompt(`big prompt ${"c".repeat(chars(promptTokens))}`);
	return { ...run, summaries: run.summaries() };
}

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("one compaction per request", () => {
	it("sends a request over the threshold but within the window without compacting again", async () => {
		// 14,100 + 11,000 crosses the threshold before the prompt; after the compaction, the kept second turn and the
		// prompt (about 17,500) are over the threshold, within the window.
		const { harness, requests, summaries } = await promptAfterCompaction(11_000);

		expect(summaries, "compactions").toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request.tokens).toBeGreaterThan(THRESHOLD);
		expect(request.tokens).toBeLessThanOrEqual(HARD_LIMIT);
		// The kept turn and the prompt reach the model word for word.
		expect(request.texts.some((text) => text.startsWith("turn two "))).toBe(true);
		expect(request.texts.at(-1)?.startsWith("big prompt ")).toBe(true);
		expect(request.texts.some((text) => text.startsWith("turn one "))).toBe(false);
	});

	it("makes room for the waiting prompt when the kept turn and the prompt would not fit the window", async () => {
		// The second turn and the prompt (about 20,500) would be past the window: the compaction before the prompt keeps
		// less, so one compaction serves the request.
		const { harness, requests, summaries } = await promptAfterCompaction(14_000);

		expect(summaries, "compactions").toBe(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request.tokens).toBeLessThanOrEqual(HARD_LIMIT);
		expect(request.texts.some((text) => text.startsWith("turn two "))).toBe(false);
		expect(request.texts.at(-1)?.startsWith("big prompt ")).toBe(true);
	});

	it("compacts again when the request after the first compaction would not fit the window", async () => {
		// The first compaction keeps the second turn anyway, so with the prompt (about 20,500) the request is past the
		// window: it compacts once more, now summarizing the second turn, and is sent with the prompt.
		const { harness, requests, summaries } = await promptAfterCompaction(14_000, { keepMoreFirst: true });

		expect(summaries, "compactions").toBe(2);
		expect(harness.eventsOfType("compaction_end").map((event) => event.result !== undefined)).toEqual([true, true]);
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request.tokens).toBeLessThanOrEqual(THRESHOLD);
		expect(request.texts.some((text) => text.startsWith("turn two "))).toBe(false);
		expect(request.texts.at(-1)?.startsWith("big prompt ")).toBe(true);
	});

	it("does not retry a compaction the user cancelled for the same request; a reply ends the hold", async () => {
		const run = await seededSession({ cancelFirst: true });
		const { harness, requests } = run;
		const prompting = harness.session.prompt(`big prompt ${"c".repeat(chars(11_000))}`);
		await run.waiting;
		harness.session.abortCompaction();
		await prompting;

		// One attempt, cancelled; the request it was for is sent as it is, over the threshold.
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").map((event) => event.aborted)).toEqual([true]);
		expect(run.summaries()).toBe(0);
		expect(requests).toHaveLength(1);
		expect(requests[0].tokens).toBeGreaterThan(THRESHOLD);
		expect(requests[0].texts.some((text) => text.startsWith("turn one "))).toBe(true);

		// After the reply, the next request over the threshold compacts again.
		await harness.session.prompt(`next prompt ${"d".repeat(chars(3_000))}`);
		expect(run.summaries()).toBe(1);
		expect(requests).toHaveLength(2);
		expect(requests[1].texts.some((text) => text.startsWith("turn one "))).toBe(false);
	});
});
