/**
 * AgentSessionRuntime forking on the faux provider: from a single message, in
 * memory (--no-session), and from the middle of a conversation.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createSessionFromServices,
} from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

/** User and assistant turns, without the session's leading system entry. */
function turns(runtime: AgentSessionRuntime) {
	return runtime.session.messages.filter((message) => message.role !== "system");
}

describe("AgentSessionRuntime forking", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntime(noSession: boolean): Promise<{ runtime: AgentSessionRuntime; harness: Harness }> {
		const tempDir = join(tmpdir(), `octocode-forking-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const sessionManager = noSession
			? SessionManager.inMemory(tempDir)
			: SessionManager.create(tempDir, join(tempDir, "sessions"));
		const harness = await createHarness({ sessionManager, cwd: tempDir });
		const services: AgentSessionServices = {
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => ({
			...(await createSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel(),
				noTools: "all",
			})),
			services,
			diagnostics: [],
		});
		const runtime = new AgentSessionRuntime(harness.session, services, factory);
		cleanups.push(async () => {
			if (runtime.session !== harness.session) {
				await runtime.dispose();
			}
			harness.cleanup();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		return { runtime, harness };
	}

	async function converse(runtime: AgentSessionRuntime, harness: Harness, ...prompts: string[]): Promise<void> {
		for (const [index, prompt] of prompts.entries()) {
			harness.appendResponses([fauxAssistantMessage(`reply ${index + 1}`)]);
			await runtime.session.prompt(prompt);
			await runtime.session.agent.waitForIdle();
		}
	}

	it("forks from a single message", async () => {
		const { runtime, harness } = await createRuntime(false);
		await converse(runtime, harness, "Say hello");

		const userMessages = runtime.session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(userMessages[0].text).toBe("Say hello");

		const result = await runtime.fork(userMessages[0].entryId);

		expect(result.cancelled).toBe(false);
		expect(result.selectedText).toBe("Say hello");
		expect(turns(runtime)).toEqual([]);
		// The fork has a session file, which is written once the fork has a turn.
		expect(runtime.session.sessionFile).toBeTruthy();
		expect(existsSync(runtime.session.sessionFile!)).toBe(false);
	});

	it("forks in memory in --no-session mode", async () => {
		const { runtime, harness } = await createRuntime(true);
		expect(runtime.session.sessionFile).toBeUndefined();
		await converse(runtime, harness, "Say hi");

		const userMessages = runtime.session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(turns(runtime).length).toBeGreaterThan(0);

		const result = await runtime.fork(userMessages[0].entryId);

		expect(result.cancelled).toBe(false);
		expect(result.selectedText).toBe("Say hi");
		expect(turns(runtime)).toEqual([]);
		expect(runtime.session.sessionFile).toBeUndefined();
	});

	it("forks from the middle of a conversation", async () => {
		const { runtime, harness } = await createRuntime(false);
		await converse(runtime, harness, "Say one", "Say two", "Say three");

		const userMessages = runtime.session.getUserMessagesForForking();
		expect(userMessages.length).toBe(3);

		const result = await runtime.fork(userMessages[1].entryId);

		expect(result.cancelled).toBe(false);
		expect(result.selectedText).toBe("Say two");
		expect(turns(runtime).map((message) => message.role)).toEqual(["user", "assistant"]);
	});
});
