import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@octocodeai/octocode-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { resetFallbackExhaustion } from "../src/core/agent-session/retry-fallback.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const PRIMARY = "claude-sonnet-4-5";
const FALLBACK = "claude-haiku-4-5";
const LIMIT = "429 insufficient_quota: You exceeded your current quota";

const reply = (model: string, overrides?: Partial<AssistantMessage>): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	api: "anthropic-messages",
	provider: "anthropic",
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
	...overrides,
});

describe("retry.fallbackCooldownMs", () => {
	let session: AgentSession | undefined;
	let dir: string;

	beforeEach(() => {
		resetFallbackExhaustion();
		dir = join(tmpdir(), `octocode-cooldown-test-${Date.now()}-${Math.random()}`);
		mkdirSync(dir, { recursive: true });
	});
	afterEach(() => {
		session?.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	/** The first two calls (the primary, then the fallback) hit a usage limit. Returns the models called. */
	async function run(cooldown?: number): Promise<string[]> {
		const calls: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBuiltinModel("anthropic", PRIMARY), systemPrompt: "Test", tools: [] },
			streamFn: (model) => {
				calls.push(model.id);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const failed = calls.length <= 2;
					const msg = failed ? reply(model.id, { stopReason: "error", errorMessage: LIMIT }) : reply(model.id);
					stream.push({ type: "start", partial: msg });
					if (failed) stream.push({ type: "error", reason: "error", error: msg });
					else stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.create(dir, dir);
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, dir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({
			retry: {
				enabled: true,
				maxRetries: 0,
				baseDelayMs: 1,
				fallbackModels: [`anthropic/${FALLBACK}`, `anthropic/${PRIMARY}`],
				...(cooldown === undefined ? {} : { fallbackCooldownMs: cooldown }),
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: dir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		await session.prompt("Test");
		return calls;
	}

	it("skips a model that failed within the default window", async () => {
		expect(await run()).toEqual([PRIMARY, FALLBACK]);
	});

	it("retries a failed model at once when the configured window is 0", async () => {
		expect(await run(0)).toEqual([PRIMARY, FALLBACK, FALLBACK]);
	});
});
