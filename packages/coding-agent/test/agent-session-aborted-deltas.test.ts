import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

/**
 * After an abort the agent stops waiting for a streaming delta's delivery, so the session's handler for one can resume
 * after its run ended, even during the next run. It must not reach the session's listeners then.
 */
describe("AgentSession deltas delivered after an abort", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `octocode-aborted-deltas-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({ streamFn: streamSimple, initialState: { model, systemPrompt: "Test", tools: [] } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRuntime: getModelRuntime(await createModelRegistry(authStorage, tempDir)),
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	it("drops a message or tool update once the run aborted, and keeps the final message", async () => {
		const seen: string[] = [];
		session.subscribe((event) => {
			seen.push(event.type);
		});
		const handle = Reflect.get(session, "_handleAgentEvent") as (
			event: AgentEvent,
			signal?: AbortSignal,
		) => Promise<void>;
		const message = fauxAssistantMessage("partial");
		const update: AgentEvent = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial", partial: message },
		};
		const toolUpdate: AgentEvent = {
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "bash",
			args: {},
			partialResult: { content: [], details: undefined },
		};

		await handle(update, new AbortController().signal);
		expect(seen).toEqual(["message_update"]);

		const aborted = AbortSignal.abort();
		await handle(update, aborted);
		await handle(toolUpdate, aborted);
		await handle({ type: "message_end", message }, aborted);
		expect(seen).toEqual(["message_update", "message_end"]);
	});
});
