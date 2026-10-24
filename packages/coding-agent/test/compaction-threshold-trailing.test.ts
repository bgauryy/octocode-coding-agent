import { existsSync, mkdirSync, rmSync } from "node:fs";
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

type CheckCompaction = (
	assistantMessage: AssistantMessage,
	skipAbortedCheck?: boolean,
	toolResults?: AgentMessage[],
	incoming?: readonly AgentMessage[],
) => Promise<boolean>;

describe("threshold compaction counts content after the last response", () => {
	let session: AgentSession;
	let tempDir: string;
	let assistant: AssistantMessage;
	let belowThreshold: number;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `pi-compaction-trailing-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({ streamFn: streamSimple, initialState: { model, systemPrompt: "Test", tools: [] } });
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		const settings = settingsManager.getCompactionSettings();
		// 100 tokens below the threshold: only trailing content can push the context over it.
		belowThreshold = (model.contextWindow ?? 200_000) - settings.reserveTokens - 100;
		assistant = {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: belowThreshold - 1_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: belowThreshold,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function check(): { run: CheckCompaction; compacted: ReturnType<typeof vi.fn> } {
		const compacted = vi
			.spyOn(session as unknown as { _runAutoCompaction: () => Promise<boolean> }, "_runAutoCompaction")
			.mockResolvedValue(true);
		const run = (session as unknown as { _checkCompaction: CheckCompaction })._checkCompaction.bind(session);
		return { run, compacted };
	}

	const bigBash = (): AgentMessage => ({
		role: "bashExecution",
		command: "cat big.log",
		output: "x".repeat(3_000),
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: Date.now() + 1,
	});

	it("does not compact when the context is below the threshold and nothing follows the response", async () => {
		session.agent.state.messages = [assistant];
		const { run, compacted } = check();
		await run(assistant, false);
		expect(compacted).not.toHaveBeenCalled();
	});

	it("compacts when an idle bash result after the response crosses the threshold", async () => {
		session.agent.state.messages = [assistant, bigBash()];
		const { run, compacted } = check();
		await run(assistant, false);
		expect(compacted).toHaveBeenCalledWith("threshold", false, session.model);
	});

	it("leaves the post-run check on provider usage alone", async () => {
		session.agent.state.messages = [assistant, bigBash()];
		const { run, compacted } = check();
		await run(assistant, true);
		expect(compacted).not.toHaveBeenCalled();
	});

	it("compacts before a large incoming prompt that would cross the threshold", async () => {
		session.agent.state.messages = [assistant];
		const { run, compacted } = check();
		const prompt: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "y".repeat(3_000) }],
			timestamp: Date.now(),
		};
		await run(assistant, false, [], [prompt]);
		expect(compacted).toHaveBeenCalledWith("threshold", false, session.model);
	});

	it("does not compact for a small incoming prompt", async () => {
		session.agent.state.messages = [assistant];
		const { run, compacted } = check();
		const prompt: AgentMessage = { role: "user", content: "hello", timestamp: Date.now() };
		await run(assistant, false, [], [prompt]);
		expect(compacted).not.toHaveBeenCalled();
	});
});
