import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

type CheckCompaction = (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

describe("checkCompaction edge cases", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;
	let runAuto: ReturnType<typeof vi.fn>;
	let events: Array<{ errorMessage?: string }>;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `octocode-compaction-edges-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({ streamFn: streamSimple, initialState: { model, systemPrompt: "Test", tools: [] } });
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ contextBudget: "full" }));
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		runAuto = vi
			.spyOn(session as unknown as { _runAutoCompaction: () => Promise<boolean> }, "_runAutoCompaction")
			.mockResolvedValue(true);
		events = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") events.push(event);
		});
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	const check = (message: AssistantMessage): Promise<boolean> =>
		(session as unknown as { _checkCompaction: CheckCompaction })._checkCompaction(message);

	function assistant(overrides: Partial<AssistantMessage>, totalTokens: number, output = 0): AssistantMessage {
		const model = session.model!;
		return {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: totalTokens - output, output, cacheRead: 0, cacheWrite: 0, totalTokens, cost: zeroCost },
			stopReason: "stop",
			timestamp: Date.now(),
			...overrides,
		};
	}

	it("L1: an errored reply after compaction still compacts when the kept context is over the threshold", async () => {
		const before = Date.now() - 10_000;
		const kept = assistant({ timestamp: before }, 190_000, 10_000);
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "kept" }], timestamp: before - 1000 });
		sessionManager.appendMessage(kept);
		sessionManager.appendCompaction("summary", sessionManager.getEntries()[0].id, 190_000, undefined, false);
		// Post-compaction content far above the threshold, then a provider error with no usage.
		const big: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "y".repeat(1_200_000) }],
			timestamp: Date.now() + 1,
		};
		sessionManager.appendMessage(big);
		const failed = assistant({ stopReason: "error", errorMessage: "529 overloaded", timestamp: Date.now() + 2 }, 0);
		session.agent.state.messages = [...sessionManager.buildSessionContext().messages, failed];
		await check(failed);
		expect(runAuto).toHaveBeenCalledWith("threshold", false, session.model);
	});

	it("L4: a length stop with a small context stays a plain truncation", async () => {
		const reply = assistant({ stopReason: "length", timestamp: Date.now() + 1 }, 5_000, 1_000);
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		sessionManager.appendMessage(reply);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		const retry = await check(reply);
		expect(retry).toBe(false);
		expect(runAuto).not.toHaveBeenCalled();
		expect(events).toEqual([]);
		expect(session.agent.state.messages.at(-1)).toBe(reply);
	});

	it("L4: a length stop with the context near the window still recovers by compacting", async () => {
		const model = session.model!;
		const reply = assistant({ stopReason: "length", timestamp: Date.now() + 1 }, model.contextWindow - 5_000, 1_000);
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		sessionManager.appendMessage(reply);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		await check(reply);
		expect(runAuto).toHaveBeenCalledWith("overflow", true, session.model);
	});
});
