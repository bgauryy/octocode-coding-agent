// B114: a fork copies the branch up to its point, and the session opened on it restores that point's model, thinking
// level and history. A switch made after the fork point stays on the source branch.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryModelsStore,
} from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestSession } from "./helpers/session.ts";
import { createTestResourceLoader } from "./utilities.ts";

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "octocode-fork-model-"));
});
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

async function runtimeWithFaux() {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		models: [
			{ id: "small", contextWindow: 10_000, maxTokens: 100, input: ["text"], reasoning: true },
			{ id: "large", contextWindow: 50_000, maxTokens: 5000, input: ["text"], reasoning: true },
		],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	faux.setResponses([fauxAssistantMessage("ok")]);
	return runtime;
}

function reply(model: "small" | "large", text: string): AssistantMessage {
	return { ...fauxAssistantMessage(text), api: "faux", provider: "faux", model };
}

/** small at low for one exchange, then a switch to large at high for a second one. Returns the first answer's entry. */
function transcript(sessionManager: SessionManager): string {
	sessionManager.appendModelChange("faux", "small");
	sessionManager.appendThinkingLevelChange("low");
	sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
	const firstAnswer = sessionManager.appendMessage(reply("small", "first answer"));
	sessionManager.appendModelChange("faux", "large");
	sessionManager.appendThinkingLevelChange("high");
	sessionManager.appendMessage({ role: "user", content: "second", timestamp: 2 });
	sessionManager.appendMessage(reply("large", "second answer"));
	return firstAnswer;
}

async function open(sessionManager: SessionManager, runtime: ModelRuntime) {
	const { session } = await createTestSession({
		cwd: tempDir,
		agentDir: tempDir,
		modelRuntime: runtime,
		sessionManager,
		resourceLoader: createTestResourceLoader(),
	});
	onTestFinished(() => session.dispose());
	return session;
}

const texts = (messages: readonly object[]) =>
	messages.map((message) => {
		const content = (message as { content?: unknown }).content;
		return typeof content === "string"
			? content
			: (content as { text?: string }[]).map((block) => block.text ?? "").join("");
	});

describe("forking a session", () => {
	it("inherits the model, thinking level and history at the fork point, under a new session id", async () => {
		const runtime = await runtimeWithFaux();
		const source = SessionManager.create(tempDir, join(tempDir, "sessions"));
		transcript(source);
		const sourceId = source.getSessionId();
		const leaf = source.getLeafId()!;

		const forkPath = source.createBranchedSession(leaf);
		expect(forkPath).toBeTruthy();
		const forked = await open(SessionManager.open(forkPath!, join(tempDir, "sessions"), tempDir), runtime);

		expect(forked.model).toMatchObject({ provider: "faux", id: "large" });
		expect(forked.thinkingLevel).toBe("high");
		expect(texts(forked.agent.state.messages)).toEqual(["first", "first answer", "second", "second answer"]);
		// A new session id is a new provider routing key (OpenAI prompt_cache_key, session headers).
		expect(forked.sessionManager.getSessionId()).not.toBe(sourceId);
	});

	it("restores the model of the fork point, not a switch made after it", async () => {
		const runtime = await runtimeWithFaux();
		const source = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const firstAnswer = transcript(source);
		// A fork at the first answer ends before the switch to large (`/model` entries precede the next prompt).
		const forkPath = source.createBranchedSession(firstAnswer);
		const forked = await open(SessionManager.open(forkPath!, join(tempDir, "sessions"), tempDir), runtime);

		expect(forked.model).toMatchObject({ provider: "faux", id: "small" });
		expect(forked.thinkingLevel).toBe("low");
		expect(texts(forked.agent.state.messages)).toEqual(["first", "first answer"]);
	});
});
