import { existsSync, mkdirSync, rmSync } from "node:fs";
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

function reply(model: string, text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
	};
}

describe("AgentSession retry.fallbackModels", () => {
	let session: AgentSession | undefined;
	let tempDir: string;

	beforeEach(() => {
		resetFallbackExhaustion();
		tempDir = join(tmpdir(), `octocode-fallback-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	/** A scripted provider: the primary model answers with `error` (a list: one per call, the last repeats), every other model succeeds. */
	async function createSession(
		fallbackModels: string[],
		error: string | string[] = "429 insufficient_quota: You exceeded your current quota",
	) {
		const calls: string[] = [];
		const errors = Array.isArray(error) ? error : [error];
		let primaryCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBuiltinModel("anthropic", PRIMARY), systemPrompt: "Test", tools: [] },
			streamFn: (model) => {
				calls.push(model.id);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					if (model.id === PRIMARY) {
						const errorMessage = errors[Math.min(primaryCalls++, errors.length - 1)];
						const msg = reply(model.id, "", { stopReason: "error", errorMessage });
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = reply(model.id, "Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-key" }));
		await authStorage.modify("opencode-go", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, fallbackModels } });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		const retries: number[] = [];
		const retryEnds: Array<{ success: boolean; attempt: number }> = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_start") retries.push(event.attempt);
			if (event.type === "auto_retry_end") retryEnds.push({ success: event.success, attempt: event.attempt });
		});
		return { session, calls, retries, retryEnds };
	}

	it.each(["hidden", "disabled"])("skips a %s fallback candidate before checking its credentials", async (reason) => {
		const created = await createSession([`anthropic/${FALLBACK}`]);
		if (reason === "hidden") created.session.modelRuntime.setHiddenModels({ anthropic: [FALLBACK] });
		else created.session.modelRuntime.setDisabledProviders(["anthropic"]);
		await created.session.prompt("Test");
		expect(created.calls).toEqual([PRIMARY]);
	});

	it("continues the turn on the first usable fallback after a usage limit, without a backoff retry", async () => {
		const created = await createSession(["nowhere/missing", `anthropic/${FALLBACK}:low`]);
		await created.session.prompt("Test");

		expect(created.calls).toEqual([PRIMARY, FALLBACK]);
		expect(created.retries).toEqual([]);
		expect(created.session.model?.id).toBe(FALLBACK);
		const last = created.session.messages.at(-1) as AssistantMessage;
		expect(last.stopReason).toBe("stop");
		// The failed attempt is omitted from what the fallback model reads.
		const projected = created.session.sessionManager.buildSessionProjection().messages;
		expect(projected.some((m) => m.role === "assistant" && m.stopReason === "error")).toBe(false);
	});

	it("closes a backoff retry series that ends in a usage limit before switching", async () => {
		const created = await createSession(
			[`anthropic/${FALLBACK}`],
			["503 overloaded_error: Overloaded", "429 insufficient_quota: You exceeded your current quota"],
		);
		await created.session.prompt("Test");
		expect(created.calls).toEqual([PRIMARY, PRIMARY, FALLBACK]);
		expect(created.retries).toEqual([1]);
		expect(created.retryEnds).toEqual([{ success: false, attempt: 1 }]);
		// The fallback starts a fresh series: a later transient failure counts from attempt 1 again.
		expect(created.session.model?.id).toBe(FALLBACK);
	});

	it("stays on the fallback for the next turn", async () => {
		const created = await createSession([`anthropic/${FALLBACK}`]);
		await created.session.prompt("one");
		await created.session.prompt("two");
		expect(created.calls).toEqual([PRIMARY, FALLBACK, FALLBACK]);
	});

	it("ends the turn with the error when no fallback is configured", async () => {
		const created = await createSession([]);
		await created.session.prompt("Test");
		expect(created.calls).toEqual([PRIMARY]);
		expect(created.session.model?.id).toBe(PRIMARY);
		expect((created.session.messages.at(-1) as AssistantMessage).errorMessage).toContain("insufficient_quota");
	});

	it.each([
		'AccessDeniedException: 403 {"message":"This model is not available for this account."}',
		'Validation error: 400 {"message":"The provided model identifier is invalid."}',
	])("immediately tries a configured sibling after a model-specific rejection: %s", async (failure) => {
		const created = await createSession(
			[`anthropic/${PRIMARY}`, `anthropic/${FALLBACK}`, "openai/gpt-4.1-mini"],
			failure,
		);
		await created.session.prompt("Test");
		expect(created.calls).toEqual([PRIMARY, FALLBACK]);
		expect(created.retries).toEqual([]);
		expect(created.session.lastRunOutcome?.warning).toContain("unavailable for this account or endpoint");
	});

	it("moves to another provider after a refused credential, skipping the refused provider's other models", async () => {
		const created = await createSession(
			[`anthropic/${FALLBACK}`, "openai/gpt-4.1-mini"],
			"OAuth refresh failed for anthropic (400 invalid_grant)",
		);
		await created.session.prompt("Test");
		expect(created.calls).toEqual([PRIMARY, "gpt-4.1-mini"]);
		expect(created.session.model?.provider).toBe("openai");
		expect(created.session.lastRunOutcome?.warning).toContain("refused the credential");
		expect(created.session.lastRunOutcome?.warning).not.toContain("billed");
	});

	it("moves on after an outage outlasts the retries", async () => {
		const created = await createSession([`anthropic/${FALLBACK}`], "500 internal server error");
		await created.session.prompt("Test");
		expect(created.calls).toEqual([PRIMARY, PRIMARY, PRIMARY, PRIMARY, FALLBACK]);
		expect(created.session.model?.id).toBe(FALLBACK);
		expect(created.session.lastRunOutcome?.warning).toContain("kept failing after retries");
	});

	it("names a change between per-token and plan billing", async () => {
		const created = await createSession(["opencode-go/minimax-m3"]);
		await created.session.prompt("Test");
		expect(created.session.model?.provider).toBe("opencode-go");
		expect(created.session.lastRunOutcome?.warning).toContain("billed by plan instead of per token");
	});

	it("does not switch on an ordinary rate limit", async () => {
		const created = await createSession([`anthropic/${FALLBACK}`], "400 invalid_request_error: bad field");
		await created.session.prompt("Test");
		expect(created.calls).toEqual([PRIMARY]);
	});
});
