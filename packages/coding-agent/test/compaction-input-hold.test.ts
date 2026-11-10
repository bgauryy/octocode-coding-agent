import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/features/index.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length) harnesses.pop()?.cleanup();
});

type Outcome =
	| { summary: string; error?: undefined; aborted?: undefined }
	| { error: string; aborted?: boolean; summary?: undefined };

interface Gate {
	/** Resolves once the summary request is in flight. */
	started: Promise<void>;
	/** Lets the summary request finish with `summary`. */
	release(summary?: string): void;
	/** Makes the summary request fail. */
	fail(message: string): void;
}

const usage = {
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function isSummaryRequest(context: TranscriptContext): boolean {
	return context.messages.some((message) => {
		const text = getMessageText(message);
		return text.startsWith("<conversation>") || text.startsWith("# Conversation\n");
	});
}

/**
 * Replaces the summary requests with ones that wait for the test (a long turn needs two); ordinary turns still reach the
 * faux provider. Once released or failed, later summary requests finish the same way at once.
 */
function gateSummary(harness: Harness): Gate {
	const agent = harness.session.agent;
	const original = agent.streamFunction;
	let markStarted = () => {};
	const started = new Promise<void>((resolve) => (markStarted = resolve));
	const waiting: Array<(outcome: Outcome) => void> = [];
	let outcome: Outcome | undefined;
	agent.streamFunction = (model, context, options) => {
		if (!isSummaryRequest(context)) return original(model, context, options);
		const stream = createAssistantMessageEventStream();
		const finish = (result: Outcome) => {
			const base = { api: model.api, provider: model.provider, model: model.id, usage };
			if (result.error !== undefined) {
				stream.push({
					type: "error",
					reason: result.aborted ? "aborted" : "error",
					error: {
						...fauxAssistantMessage("", {
							stopReason: result.aborted ? "aborted" : "error",
							errorMessage: result.error,
						}),
						...base,
					},
				});
			} else
				stream.push({ type: "done", reason: "stop", message: { ...fauxAssistantMessage(result.summary), ...base } });
		};
		options?.signal?.addEventListener("abort", () => finish({ error: "aborted", aborted: true }), { once: true });
		if (outcome) queueMicrotask(() => finish(outcome as Outcome));
		else waiting.push(finish);
		markStarted();
		return stream;
	};
	const settle = (result: Outcome) => {
		outcome = result;
		for (const finish of waiting.splice(0)) finish(result);
	};
	return {
		started,
		release: (summary = "SUMMARY") => settle({ summary }),
		fail: (message) => settle({ error: message }),
	};
}

type Ending = "success" | "fail" | "cancel";
const ENDINGS: Ending[] = ["success", "fail", "cancel"];

/** One line per message the agent holds (what the next model request carries). */
function contextLines(harness: Harness): string[] {
	return harness.session.messages.map((message) => `${message.role}:${getMessageText(message)}`);
}

/** One line per transcript entry on the current branch. */
function branchLines(harness: Harness): string[] {
	return harness.sessionManager.getBranch().map((entry) => {
		if (entry.type === "message") return `${entry.message.role}:${getMessageText(entry.message)}`;
		if (entry.type === "custom_message")
			return `custom:${typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content)}`;
		return entry.type;
	});
}

const count = (lines: readonly string[], text: string) => lines.filter((line) => line.includes(text)).length;

type Request = string[];
/** A faux reply that records the request it answers. */
function reply(requests: Request[], text: string) {
	return (context: TranscriptContext) => {
		requests.push(context.messages.map((message) => `${message.role}:${getMessageText(message)}`));
		return fauxAssistantMessage(text);
	};
}

/**
 * Ends a gated compaction as the test asks: the summary arrives, the summarizer throws, or the user cancels. After a cancel
 * a later automatic attempt (the context is still large) finds the summarizer failing instead of waiting for the test.
 */
function end(harness: Harness, gate: Gate, ending: Ending): void {
	if (ending === "success") gate.release();
	else if (ending === "fail") gate.fail("summarizer exploded");
	else {
		harness.session.abortCompaction();
		gate.fail("summarizer unavailable after the cancel");
	}
}

async function seededHarness(options: { tools?: AgentTool[] } = {}): Promise<Harness> {
	const harness = await createHarness({ compactionPolicy: { keepRecentTokens: 1 }, ...options });
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
	await harness.session.prompt("seed one");
	await harness.session.prompt("seed two");
	return harness;
}

/** Every input is in the transcript and the agent's context exactly once; after a compaction that saved, behind its summary. */
function expectEachOnce(harness: Harness, texts: string[], ending: Ending): void {
	const branch = branchLines(harness);
	const context = contextLines(harness);
	for (const text of texts) {
		expect(count(branch, text), `${text} in transcript`).toBe(1);
		expect(count(context, text), `${text} in context`).toBe(1);
	}
	expect(branch.includes("compaction")).toBe(ending === "success");
	if (ending === "success") {
		const summary = context.findIndex((line) => line.startsWith("compactionSummary"));
		expect(summary).toBeGreaterThan(-1);
		for (const text of texts) expect(context.findIndex((line) => line.includes(text))).toBeGreaterThan(summary);
	}
	expect(harness.session.getQueuedInputs()).toEqual([]);
	expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	expect(harness.session.isCompacting).toBe(false);
}

describe("manual /compact: input that arrives while the summary is running", () => {
	it.each(ENDINGS)(
		"holds every path, runs nothing meanwhile, and delivers each once in order afterwards (%s)",
		async (ending) => {
			const harness = await seededHarness();
			const requests: Request[] = [];
			harness.appendResponses(Array.from({ length: 8 }, (_, index) => reply(requests, `turn ${index + 1}`)));
			const gate = gateSummary(harness);
			const compacting = harness.session.compact().then(
				() => undefined,
				() => undefined,
			);
			await gate.started;
			const { session } = harness;
			expect(session.isCompacting).toBe(true);
			await session.prompt("bare prompt");
			await session.sendUserMessage("bare user message");
			await session.sendUserMessage("steered user message", { deliverAs: "steer" });
			await expect(session.steer("steer one")).resolves.toBe("queued");
			await session.followUp("follow one");
			await session.sendCustomMessage(
				{ customType: "wake", content: "wake-up call", display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			await session.sendCustomMessage({ customType: "note", content: "plain note", display: true });
			await session.sendCustomMessage(
				{ customType: "note", content: "later note", display: true },
				{ deliverAs: "nextTurn" },
			);
			// Nothing ran: no model request, no transcript entry, everything waits in the queues.
			expect(requests).toHaveLength(0);
			const waiting = branchLines(harness);
			for (const text of ["bare prompt", "steer one", "wake-up call", "plain note"])
				expect(count(waiting, text)).toBe(0);
			expect(session.getQueuedInputs().map((input) => input.text)).toEqual([
				"steered user message",
				"steer one",
				"bare prompt",
				"bare user message",
				"follow one",
			]);

			end(harness, gate, ending);
			await compacting;
			await vi.waitFor(() => expect(session.agent.hasQueuedMessages() || session.isStreaming).toBe(false), {
				timeout: 10_000,
			});
			await session.waitForIdle();
			const inputs = [
				"bare prompt",
				"bare user message",
				"steered user message",
				"steer one",
				"follow one",
				"wake-up call",
				"plain note",
				"later note",
			];
			expectEachOnce(harness, inputs, ending);
			const context = contextLines(harness);
			const at = (text: string) => context.findIndex((line) => line.includes(text));
			expect(at("steered user message")).toBeLessThan(at("steer one"));
			expect(at("steer one")).toBeLessThan(at("wake-up call"));
			expect(at("wake-up call")).toBeLessThan(at("bare prompt"));
			expect(at("bare prompt")).toBeLessThan(at("bare user message"));
			expect(at("bare user message")).toBeLessThan(at("follow one"));
			// The first request after the compaction carries the summary (when it was saved) and each input at most once.
			for (const request of requests) {
				expect(
					request.some(
						(line) => line.startsWith("compactionSummary") || line.startsWith("user:The conversation history"),
					),
				).toBe(ending === "success");
				for (const text of inputs) expect(count(request, text)).toBeLessThanOrEqual(1);
			}
		},
	);

	it.each(ENDINGS)(
		"keeps the tool results of a turn a waking message starts after the compaction (%s)",
		async (ending) => {
			let releaseTool = () => {};
			const toolGate = new Promise<void>((resolve) => (releaseTool = resolve));
			const slow: AgentTool = {
				name: "slow",
				label: "slow",
				description: "waits for the test",
				parameters: Type.Object({}),
				execute: async () => {
					await toolGate;
					return { content: [{ type: "text", text: "slow-result" }], details: {} };
				},
			};
			const harness = await seededHarness({ tools: [slow] });
			const requests: Request[] = [];
			harness.appendResponses([
				fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
				reply(requests, "woke"),
			]);
			const gate = gateSummary(harness);
			const compacting = harness.session.compact().then(
				() => undefined,
				() => undefined,
			);
			await gate.started;
			await harness.session.sendCustomMessage(
				{ customType: "wake", content: "wake-up call", display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(harness.session.isStreaming).toBe(false);
			end(harness, gate, ending);
			await compacting;
			await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true), { timeout: 10_000 });
			releaseTool();
			await harness.session.waitForIdle();
			expectEachOnce(harness, ["wake-up call", "slow-result"], ending);
			expect(count(requests[0] ?? [], "slow-result")).toBe(1);
			expect(contextLines(harness).at(-1)).toBe("assistant:woke");
		},
	);
});

describe("automatic compaction (threshold, mid-run): input that arrives while the summary is running", () => {
	const tool: AgentTool = {
		name: "large_result",
		label: "Large result",
		description: "Returns enough content to cross the compaction threshold",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: `big:${"x".repeat(5200)}` }], details: {} }),
	};

	async function startRun(): Promise<{ harness: Harness; gate: Gate; requests: Request[]; running: Promise<void> }> {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3200, maxTokens: 100 }],
			compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 1000 },
			tools: [tool],
		});
		harnesses.push(harness);
		const requests: Request[] = [];
		harness.setResponses([
			fauxAssistantMessage(`old:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			...Array.from({ length: 8 }, (_, index) => reply(requests, `turn ${index + 1}`)),
		]);
		await harness.session.prompt("seed old");
		await harness.session.prompt("seed recent");
		const gate = gateSummary(harness);
		const running = harness.session.prompt("run the tools");
		await gate.started;
		return { harness, gate, requests, running };
	}

	it.each(ENDINGS)(
		"delivers every queued input once, in arrival order per queue, and leaves no queue behind (%s)",
		async (ending) => {
			const { harness, gate, requests, running } = await startRun();
			const { session } = harness;
			expect(session.isCompacting).toBe(true);
			await session.prompt("steer via prompt", { streamingBehavior: "steer" });
			await session.steer("steer via steer");
			await session.sendUserMessage("steer via extension", { deliverAs: "steer" });
			await session.sendCustomMessage(
				{ customType: "mail", content: "steer via mail", display: true },
				{ triggerTurn: true, deliverAs: "steer" },
			);
			await session.prompt("follow via prompt", { streamingBehavior: "followUp" });
			await session.followUp("follow via followUp");
			await session.sendCustomMessage(
				{ customType: "report", content: "follow via report", display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			await session.sendCustomMessage(
				{ customType: "note", content: "note without turn", display: true },
				{ triggerTurn: false },
			);
			const queued = [
				"steer via prompt",
				"steer via steer",
				"steer via extension",
				"follow via prompt",
				"follow via followUp",
			];
			expect(session.getQueuedInputs().map((input) => input.text)).toEqual(queued);

			end(harness, gate, ending);
			await running;
			const inputs = [...queued, "steer via mail", "follow via report", "note without turn"];
			expectEachOnce(harness, inputs, ending);
			const context = contextLines(harness);
			const at = (text: string) => context.findIndex((line) => line.includes(text));
			expect(at("steer via prompt")).toBeLessThan(at("steer via steer"));
			expect(at("steer via steer")).toBeLessThan(at("steer via extension"));
			expect(at("steer via extension")).toBeLessThan(at("steer via mail"));
			expect(at("steer via mail")).toBeLessThan(at("follow via prompt"));
			expect(at("follow via prompt")).toBeLessThan(at("follow via followUp"));
			expect(at("follow via followUp")).toBeLessThan(at("follow via report"));
			// The last request carries each input once, so nothing was sent twice to the model.
			const last = requests.at(-1) ?? [];
			for (const text of inputs.filter((input) => input !== "note without turn")) expect(count(last, text)).toBe(1);
		},
	);

	it("refuses a prompt or user message that names no queue, with a reason, and loses nothing", async () => {
		const { harness, gate, running } = await startRun();
		await expect(harness.session.prompt("bare prompt")).rejects.toThrow(/already processing/);
		await expect(harness.session.sendUserMessage("bare user message")).rejects.toThrow(/already processing/);
		gate.release();
		await running;
		const branch = branchLines(harness);
		expect(count(branch, "bare prompt") + count(branch, "bare user message")).toBe(0);
		expectEachOnce(harness, [], "success");
	});
});

describe("automatic compaction before a prompt is sent: input that arrives while the summary is running", () => {
	it.each(ENDINGS)("delivers queued input once behind the prompt that waited (%s)", async (ending) => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 3200, maxTokens: 100 }],
			compactionPolicy: { enabled: true, reserveTokens: 400, keepRecentTokens: 100 },
		});
		harnesses.push(harness);
		const requests: Request[] = [];
		harness.setResponses([
			fauxAssistantMessage(`old:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent:${"b".repeat(800)}`),
			...Array.from({ length: 6 }, (_, index) => reply(requests, `turn ${index + 1}`)),
		]);
		await harness.session.prompt("seed old");
		await harness.session.prompt("seed recent");
		const gate = gateSummary(harness);
		// The incoming prompt alone pushes the context over the threshold, so it waits for the summary.
		const running = harness.session.prompt(`big prompt ${"y".repeat(9000)}`);
		await gate.started;
		expect(harness.session.isCompacting).toBe(true);
		await harness.session.steer("steer while waiting");
		await harness.session.followUp("follow while waiting");
		await harness.session.sendCustomMessage(
			{ customType: "mail", content: "mail while waiting", display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		await expect(harness.session.prompt("bare while waiting")).rejects.toThrow(/already processing/);

		end(harness, gate, ending);
		await running;
		expectEachOnce(
			harness,
			["big prompt", "steer while waiting", "follow while waiting", "mail while waiting"],
			ending,
		);
		expect(count(branchLines(harness), "bare while waiting")).toBe(0);
		const context = contextLines(harness);
		const at = (text: string) => context.findIndex((line) => line.includes(text));
		expect(at("big prompt")).toBeLessThan(at("steer while waiting"));
		expect(at("steer while waiting")).toBeLessThan(at("mail while waiting"));
		expect(at("mail while waiting")).toBeLessThan(at("follow while waiting"));
	});
});

describe("overflow recovery: input that arrives while the summary is running", () => {
	it.each(ENDINGS)("delivers a steer queued during the recovery compaction once (%s)", async (ending) => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 1300, maxTokens: 100 }],
			tools: [],
			compactionPolicy: { keepRecentTokens: 1, reserveTokens: 100 },
		});
		harnesses.push(harness);
		const requests: Request[] = [];
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			reply(requests, "recovered"),
			reply(requests, "after steer"),
			reply(requests, "spare"),
		]);
		const gate = gateSummary(harness);
		const running = harness.session.prompt("x".repeat(5000)).then(
			() => undefined,
			() => undefined,
		);
		await gate.started;
		await harness.session.steer("steer during recovery");
		await harness.session.sendCustomMessage(
			{ customType: "mail", content: "mail during recovery", display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		await harness.session.followUp("follow during recovery");

		end(harness, gate, ending);
		await running;
		const branch = branchLines(harness);
		for (const text of ["steer during recovery", "mail during recovery", "follow during recovery"]) {
			expect(count(branch, text), text).toBe(1);
			expect(count(requests.at(-1) ?? [], text), `${text} in the last request`).toBeLessThanOrEqual(1);
		}
		expect(harness.session.getQueuedInputs()).toEqual([]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
	});
});

describe("extension hooks that fire while compaction runs", () => {
	it("holds sendUserMessage and sendMessage from session_before_compact until the compaction ends, and delivers each once", async () => {
		const errors: string[] = [];
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			compactionPolicy: { keepRecentTokens: 1 },
			extensionFactories: [
				(extension) => {
					api = extension;
					extension.on("session_before_compact", async () => {
						extension.sendUserMessage("from the hook");
						await extension.sendMessage(
							{ customType: "hook-note", content: "hook note", display: true },
							{ triggerTurn: false },
						);
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("a1"),
			fauxAssistantMessage("a2"),
			fauxAssistantMessage("answered the hook"),
			fauxAssistantMessage("spare"),
		]);
		await harness.session.prompt("seed one");
		await harness.session.prompt("seed two");
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		const gate = gateSummary(harness);
		const compacting = harness.session.compact();
		await gate.started;
		gate.release();
		await compacting;
		await vi.waitFor(() => expect(count(branchLines(harness), "from the hook")).toBe(1), { timeout: 10_000 });
		await harness.session.waitForIdle();
		expect(api).toBeDefined();
		// The hook's message is held and delivered, not refused as an extension error.
		expect(errors).toEqual([]);
		expectEachOnce(harness, ["hook note", "from the hook"], "success");
	});
});

describe("the compact tool's queued request (what `requests.settle` does when the run settles)", () => {
	it.each(ENDINGS)("holds input that arrives during it, then resumes the task once (%s)", async (ending) => {
		const resumes: string[] = [];
		let arm = () => {};
		const harness = await createHarness({
			compactionPolicy: { keepRecentTokens: 1 },
			extensionFactories: [
				(extension) => {
					let requested = true;
					arm = () => (requested = false);
					extension.on("agent_settled", async (_event, ctx) => {
						if (requested) return;
						requested = true;
						// As `CompactRequests.settle` does: compact in the background, then resume (or report) with a message.
						ctx.compact({
							onComplete: () => {
								resumes.push("done");
								void extension.sendMessage(
									{ customType: "resume", content: "RESUME-TASK", display: false },
									{ triggerTurn: true },
								);
							},
							onError: () => {
								resumes.push("failed");
								void extension.sendMessage(
									{ customType: "resume", content: "COMPACT-FAILED", display: false },
									{ triggerTurn: false },
								);
							},
						});
					});
				},
			],
		});
		harnesses.push(harness);
		const requests: Request[] = [];
		harness.setResponses([
			fauxAssistantMessage("a1"),
			fauxAssistantMessage("a2"),
			fauxAssistantMessage("a3"),
			...Array.from({ length: 6 }, (_, index) => reply(requests, `turn ${index + 1}`)),
		]);
		await harness.session.prompt("seed one");
		await harness.session.prompt("seed two");
		const gate = gateSummary(harness);
		arm();
		await harness.session.prompt("the work");
		await gate.started;
		expect(harness.session.isCompacting).toBe(true);
		await harness.session.prompt("typed meanwhile");
		expect(count(branchLines(harness), "typed meanwhile")).toBe(0);
		await harness.session.steer("steered meanwhile");
		await harness.session.sendCustomMessage({ customType: "note", content: "note meanwhile", display: true });

		end(harness, gate, ending);
		await vi.waitFor(() => expect(resumes).toHaveLength(1), { timeout: 10_000 });
		await harness.session.waitForIdle();
		expect(resumes).toEqual([ending === "success" ? "done" : "failed"]);
		// The typed prompt and the steer are held and delivered on every ending, once.
		const marker = ending === "success" ? "RESUME-TASK" : "COMPACT-FAILED";
		expectEachOnce(harness, ["typed meanwhile", "steered meanwhile", "note meanwhile", marker], ending);
		expect(branchLines(harness).findIndex((line) => line.includes("steered meanwhile"))).toBeLessThan(
			branchLines(harness).findIndex((line) => line.includes("typed meanwhile")),
		);
	});
});
