// B123 L4: a session reopened with a thinking level (`--thinking`) records it, so the next reopen keeps it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxProvider, InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestSession } from "./helpers/session.ts";
import { createTestResourceLoader } from "./utilities.ts";

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "octocode-resume-thinking-"));
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
		models: [{ id: "thinker", contextWindow: 50_000, maxTokens: 5000, input: ["text"], reasoning: true }],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

async function open(path: string, runtime: ModelRuntime, thinkingLevel?: ThinkingLevel) {
	const { session } = await createTestSession({
		cwd: tempDir,
		agentDir: tempDir,
		modelRuntime: runtime,
		sessionManager: SessionManager.open(path, join(tempDir, "sessions"), tempDir),
		resourceLoader: createTestResourceLoader(),
		thinkingLevel,
	});
	onTestFinished(() => session.dispose());
	return session;
}

describe("resuming with a thinking level", () => {
	it("records the new level, so the next reopen restores it", async () => {
		const runtime = await runtimeWithFaux();
		const source = SessionManager.create(tempDir, join(tempDir, "sessions"));
		source.appendModelChange("faux", "thinker");
		source.appendThinkingLevelChange("low");
		source.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		source.appendMessage({ ...fauxAssistantMessage("ok"), api: "faux", provider: "faux", model: "thinker" });
		const path = source.getSessionFile()!;

		const resumed = await open(path, runtime, "high");
		expect(resumed.thinkingLevel).toBe("high");
		resumed.dispose();

		const reopened = await open(path, runtime);
		expect(reopened.thinkingLevel).toBe("high");
	});

	it("records nothing when the level is the one the session already holds", async () => {
		const runtime = await runtimeWithFaux();
		const source = SessionManager.create(tempDir, join(tempDir, "sessions"));
		source.appendModelChange("faux", "thinker");
		source.appendThinkingLevelChange("low");
		source.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		source.appendMessage({ ...fauxAssistantMessage("ok"), api: "faux", provider: "faux", model: "thinker" });

		const resumed = await open(source.getSessionFile()!, runtime, "low");
		const entries = resumed.sessionManager.getEntries().filter((entry) => entry.type === "thinking_level_change");
		expect(entries).toHaveLength(1);
	});
});
