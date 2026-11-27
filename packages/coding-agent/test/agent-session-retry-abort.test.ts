import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@octocodeai/octocode-agent-core";
import { type AssistantMessage, createAssistantMessageEventStream } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const reply = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
	role: "assistant",
	content: [],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
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

describe("a Stop during a retried request", () => {
	let session: AgentSession | undefined;
	let dir: string | undefined;
	afterEach(() => {
		session?.dispose();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("ends the retry series as cancelled, never as a success", async () => {
		dir = mkdtempSync(join(tmpdir(), "octocode-retry-abort-"));
		let calls = 0;
		let retriedRequestOut!: () => void;
		const out = new Promise<void>((resolve) => {
			retriedRequestOut = resolve;
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: getBuiltinModel("anthropic", "claude-sonnet-4-5"), systemPrompt: "Test", tools: [] },
			streamFn: (_model, _context, options) => {
				calls++;
				const stream = createAssistantMessageEventStream();
				if (calls === 1) {
					queueMicrotask(() => {
						const failed = reply({ stopReason: "error", errorMessage: "503 Service Unavailable" });
						stream.push({ type: "start", partial: failed });
						stream.push({ type: "error", reason: "error", error: failed });
					});
					return stream;
				}
				// The retried request streams until the user stops it.
				const partial = reply({});
				queueMicrotask(() => {
					stream.push({ type: "start", partial });
					retriedRequestOut();
				});
				options?.signal?.addEventListener("abort", () => {
					const aborted = reply({ stopReason: "aborted", errorMessage: "Request was aborted" });
					stream.push({ type: "error", reason: "aborted", error: aborted });
				});
				return stream;
			},
		});
		const settingsManager = SettingsManager.create(dir, dir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		const authStorage = AuthStorage.create(join(dir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: dir,
			modelRuntime: getModelRuntime(await createModelRegistry(authStorage, dir)),
			resourceLoader: createTestResourceLoader(),
		});
		const ends: Array<{ success: boolean; finalError?: string }> = [];
		session.subscribe((event) => {
			if (event.type === "auto_retry_end") ends.push({ success: event.success, finalError: event.finalError });
		});

		const run = session.prompt("Test");
		await out;
		await session.abort();
		await run;

		expect(calls).toBe(2);
		expect(ends).toEqual([{ success: false, finalError: "Retry cancelled" }]);
		expect(session.isRetrying).toBe(false);
	});
});
