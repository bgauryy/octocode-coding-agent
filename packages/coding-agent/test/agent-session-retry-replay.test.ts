import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentTool } from "@octocodeai/octocode-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { resetFallbackExhaustion } from "../src/core/agent-session/retry-fallback.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Settings } from "../src/core/settings-schema.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

/**
 * Retry replay safety and `retry.fallbackChains` through a whole session on a scripted provider: a failed request is
 * sent again only when it committed no visible text and ran no tool, and a chain is followed in order with a fresh
 * retry budget for each model.
 */
const PRIMARY = "claude-sonnet-4-5";
const HAIKU = "claude-haiku-4-5";
const GPT = "gpt-4.1-mini";
const OVERLOADED = "503 service unavailable: overloaded";
const USAGE = "429 insufficient_quota: You exceeded your current quota";

/** What one request does: fail after streaming `text` and/or a finished read-only call, or answer. */
interface Step {
	error?: string;
	text?: string;
	tool?: boolean;
}
type Script = Record<string, Step[]>;

function message(model: string, partial: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: model === GPT ? "openai" : "anthropic",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...partial,
	};
}

describe("retry replay safety and fallbackChains", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		resetFallbackExhaustion();
		tempDir = join(tmpdir(), `octocode-replay-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
	});
	afterEach(() => {
		session?.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	/** `script[model]` lists that model's requests in order; the last step repeats. An unlisted model answers. */
	async function create(script: Script, retry: Settings["retry"] = {}) {
		const requests: string[] = [];
		const used: Record<string, number> = {};
		const executed: string[] = [];
		const tool: AgentTool<any> = {
			name: "peek",
			label: "peek",
			description: "Reads nothing.",
			parameters: Type.Object({}),
			execute: async (id) => {
				executed.push(id);
				return { content: [{ type: "text", text: "seen" }], details: {} };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBuiltinModel("anthropic", PRIMARY), systemPrompt: "Test", tools: [tool] },
			streamFn: (model) => {
				requests.push(model.id);
				const steps = script[model.id] ?? [{}];
				const step = steps[Math.min(used[model.id] ?? 0, steps.length - 1)];
				used[model.id] = (used[model.id] ?? 0) + 1;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(async () => {
					const start = message(model.id, {});
					stream.push({ type: "start", partial: start });
					if (!step.error) {
						const done = message(model.id, { content: [{ type: "text", text: "Success" }] });
						stream.push({ type: "done", reason: "stop", message: done });
						return;
					}
					const content: AssistantMessage["content"] = [];
					if (step.tool) {
						const call = { type: "toolCall" as const, id: `call-${requests.length}`, name: "peek", arguments: {} };
						content.push(call);
						stream.push({ type: "toolcall_start", contentIndex: 0, partial: message(model.id, { content }) });
						stream.push({
							type: "toolcall_end",
							contentIndex: 0,
							toolCall: call,
							partial: message(model.id, { content }),
						});
					}
					if (step.text !== undefined) {
						const index = content.length;
						content.push({ type: "text", text: step.text });
						stream.push({ type: "text_start", contentIndex: index, partial: message(model.id, { content }) });
						stream.push({
							type: "text_delta",
							contentIndex: index,
							delta: step.text,
							partial: message(model.id, { content }),
						});
					}
					// Let an early-started call begin before the stream fails.
					await new Promise((resolve) => setTimeout(resolve, 20));
					const failed = message(model.id, { content, stopReason: "error", errorMessage: step.error });
					stream.push({ type: "error", reason: "error", error: failed });
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		for (const provider of ["anthropic", "openai"])
			await authStorage.modify(provider, async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({
			retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, ...retry },
			toolExecution: { earlyStart: true },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
			customTools: [tool as never],
			initialActiveToolNames: ["peek"],
		});
		// The scripted tool has no feature gate to ask: let its call start while the message streams.
		session.featureHost.mayStartToolCallEarly = () => true;
		// No permission policy for the scripted tool: the early call neither asks nor defers.
		agent.beforeToolCall = async () => undefined;
		const delays: number[] = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") delays.push(event.delayMs);
		});
		return { session, requests, executed, delays };
	}

	const lastError = (s: AgentSession) => (s.messages.at(-1) as AssistantMessage).errorMessage;

	it("retries a failure that committed nothing", async () => {
		const created = await create({ [PRIMARY]: [{ error: OVERLOADED }, {}] });
		await created.session.prompt("Test");
		expect(created.requests).toEqual([PRIMARY, PRIMARY]);
		expect((created.session.messages.at(-1) as AssistantMessage).stopReason).toBe("stop");
	});

	it("does not resend after text was streamed, and surfaces the error", async () => {
		const created = await create({ [PRIMARY]: [{ error: OVERLOADED, text: "Here is the plan: " }, {}] });
		await created.session.prompt("Test");
		expect(created.requests).toEqual([PRIMARY]);
		expect(created.delays).toEqual([]);
		expect(lastError(created.session)).toContain("503");
	});

	it("does not switch models after text was streamed", async () => {
		const created = await create(
			{ [PRIMARY]: [{ error: USAGE, text: "Half an answer" }] },
			{ fallbackChains: { [`anthropic/${PRIMARY}`]: [`anthropic/${HAIKU}`] } },
		);
		await created.session.prompt("Test");
		expect(created.requests).toEqual([PRIMARY]);
		expect(created.session.model?.id).toBe(PRIMARY);
	});

	it("never runs a tool twice when its request failed after the tool started", async () => {
		const created = await create({ [PRIMARY]: [{ error: OVERLOADED, tool: true, text: "" }, {}] });
		await created.session.prompt("Test");
		expect(created.executed).toHaveLength(1);
		expect(created.requests).toEqual([PRIMARY]);
		expect(created.delays).toEqual([]);
	});

	it("follows the chain in order, skipping a model that fails in turn", async () => {
		const created = await create(
			{ [PRIMARY]: [{ error: USAGE }], [HAIKU]: [{ error: USAGE }] },
			{ fallbackChains: { [`anthropic/${PRIMARY}`]: [`anthropic/${HAIKU}`, `openai/${GPT}:low`] } },
		);
		await created.session.prompt("Test");
		expect(created.requests).toEqual([PRIMARY, HAIKU, GPT]);
		expect(created.session.model?.id).toBe(GPT);
	});

	it("uses the chain of the failing model, not fallbackModels, and a glob key matches", async () => {
		const created = await create(
			{ [PRIMARY]: [{ error: USAGE }] },
			{ fallbackModels: [`anthropic/${HAIKU}`], fallbackChains: { "anthropic/claude-sonnet-*": [`openai/${GPT}`] } },
		);
		await created.session.prompt("Test");
		expect(created.requests).toEqual([PRIMARY, GPT]);
	});

	it("switches only on the classes fallbackOn names", async () => {
		const chains = { fallbackChains: { [`anthropic/${PRIMARY}`]: [`anthropic/${HAIKU}`] } };
		const usageOnly = await create({ [PRIMARY]: [{ error: OVERLOADED }] }, { ...chains, fallbackOn: ["usage"] });
		await usageOnly.session.prompt("Test");
		// Outage is not listed: the retries run, then the turn ends on the primary.
		expect(usageOnly.requests.every((id) => id === PRIMARY)).toBe(true);
		expect(usageOnly.session.model?.id).toBe(PRIMARY);
		session?.dispose();

		const outage = await create({ [PRIMARY]: [{ error: OVERLOADED }] }, { ...chains, fallbackOn: ["outage"] });
		await outage.session.prompt("Test");
		expect(outage.requests.at(-1)).toBe(HAIKU);
	});

	it("does not switch on a rate limit unless fallbackOn lists it", async () => {
		const limited = "429 too many requests";
		const chains = { fallbackChains: { [`anthropic/${PRIMARY}`]: [`anthropic/${HAIKU}`] } };
		const off = await create({ [PRIMARY]: [{ error: limited }] }, { ...chains, maxRetries: 1 });
		await off.session.prompt("Test");
		expect(off.requests).not.toContain(HAIKU);
		session?.dispose();

		resetFallbackExhaustion();
		const on = await create(
			{ [PRIMARY]: [{ error: limited }] },
			{ ...chains, maxRetries: 1, fallbackOn: ["rate-limit"] },
		);
		await on.session.prompt("Test");
		expect(on.requests.at(-1)).toBe(HAIKU);
	});

	it("gives each fallback model a fresh retry budget", async () => {
		const created = await create(
			{ [PRIMARY]: [{ error: OVERLOADED }], [HAIKU]: [{ error: OVERLOADED }] },
			{ maxRetries: 2, fallbackChains: { [`anthropic/${PRIMARY}`]: [`anthropic/${HAIKU}`, `openai/${GPT}`] } },
		);
		await created.session.prompt("Test");
		// 6 is the floor for an overload: each model spends its own six retries before the next one starts.
		const perModel = (id: string) => created.requests.filter((request) => request === id).length;
		expect(perModel(PRIMARY)).toBe(7);
		expect(perModel(HAIKU)).toBe(7);
		expect(created.requests.at(-1)).toBe(GPT);
	});

	it("keeps every backoff within maxAgentDelayMs", async () => {
		const created = await create(
			{ [PRIMARY]: [{ error: "500 internal server error" }] },
			{ maxRetries: 6, baseDelayMs: 8, maxAgentDelayMs: 20 },
		);
		await created.session.prompt("Test");
		expect(created.delays.length).toBe(6);
		expect(Math.max(...created.delays)).toBeLessThanOrEqual(20);
	});
});
