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
import { estimateTokens } from "../src/core/compaction/tokens.ts";
import { compactionThresholdTokens } from "../src/core/compaction/settings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

type CheckCompaction = (assistantMessage: AssistantMessage, skipAbortedCheck?: boolean) => Promise<boolean>;

describe("threshold compaction floors provider usage by a local estimate", () => {
	let session: AgentSession;
	let tempDir: string;
	let threshold: number;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `octocode-compaction-floor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({ streamFn: streamSimple, initialState: { model, systemPrompt: "Test", tools: [] } });
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ contextBudget: "full" }));
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
		threshold = compactionThresholdTokens(model.contextWindow, settingsManager.getCompactionSettings(model));
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	const reply = (totalTokens: number): AssistantMessage => {
		const model = session.model!;
		return {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: totalTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() + 1,
		};
	};

	const user = (chars: number): AgentMessage => ({
		role: "user",
		content: [{ type: "text", text: "x".repeat(chars) }],
		timestamp: Date.now(),
	});

	function check(): { run: CheckCompaction; compacted: ReturnType<typeof vi.fn> } {
		const compacted = vi
			.spyOn(session as unknown as { _runAutoCompaction: () => Promise<boolean> }, "_runAutoCompaction")
			.mockResolvedValue(true);
		return {
			run: (session as unknown as { _checkCompaction: CheckCompaction })._checkCompaction.bind(session),
			compacted,
		};
	}

	it("compacts when the stored messages are far over the threshold though the provider reported a small count", async () => {
		const response = reply(1_000);
		session.agent.state.messages = [user(threshold * 8), response];
		const { run, compacted } = check();
		await run(response, true);
		expect(compacted).toHaveBeenCalledWith("threshold", false, session.model);
	});

	it("trusts the provider's count when the local estimate is lower", async () => {
		const response = reply(threshold + 1_000);
		session.agent.state.messages = [user(400), response];
		const { run, compacted } = check();
		await run(response, true);
		expect(compacted).toHaveBeenCalledWith("threshold", false, session.model);
	});

	it("does not compact when both counts are below the threshold", async () => {
		const response = reply(1_000);
		session.agent.state.messages = [user(400), response];
		const { run, compacted } = check();
		await run(response, true);
		expect(compacted).not.toHaveBeenCalled();
	});

	describe("the override gate (the local estimate is a ratio estimate: it wins only past twice the provider count)", () => {
		/** Stored messages whose local estimate is 1.3 times the threshold; returns that estimate. */
		const seed = (): { stored: AgentMessage[]; estimate: number } => {
			const model = session.model;
			const probe = user(10_000);
			const perChar = estimateTokens(probe, model) / 10_000;
			const stored = [user(Math.ceil((1.3 * threshold) / perChar))];
			const estimate = stored.reduce((sum, message) => sum + estimateTokens(message, model), 0);
			return { stored, estimate };
		};

		it("keeps the provider's count when the estimate is between one and two times it", async () => {
			const { stored, estimate } = seed();
			const response = reply(Math.floor(estimate / 1.5));
			expect(response.usage.totalTokens).toBeLessThan(threshold);
			session.agent.state.messages = [...stored, response];
			const { run, compacted } = check();
			await run(response, true);
			expect(compacted).not.toHaveBeenCalled();
		});

		it("overrides the provider's count when the estimate is more than twice it", async () => {
			const { stored, estimate } = seed();
			const response = reply(Math.floor(estimate / 2.5));
			session.agent.state.messages = [...stored, response];
			const { run, compacted } = check();
			await run(response, true);
			expect(compacted).toHaveBeenCalledWith("threshold", false, session.model);
		});
	});
});
