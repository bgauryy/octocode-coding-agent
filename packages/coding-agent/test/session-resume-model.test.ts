// B347 P2-4: a session resumed with another model (a subagent resume, `octocode --session X --model Y`) records the change,
// so its transcript names the model that answers from then on and a later reopen without a model restores it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryModelsStore,
	type Model,
} from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createTestSession } from "./helpers/session.ts";
import type { CreateTestSessionOptions } from "./helpers/session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "octocode-resume-model-"));
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
			{ id: "small", contextWindow: 1000, maxTokens: 100, input: ["text"], reasoning: true },
			{ id: "large", contextWindow: 50_000, maxTokens: 5000, input: ["text"], reasoning: true },
		],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
	return runtime;
}

/** A transcript that chose faux/small at thinking level low and has one exchange. */
function transcript(runtime: ModelRuntime): SessionManager {
	const sessionManager = SessionManager.inMemory(tempDir);
	const small = runtime.getModel("faux", "small")!;
	sessionManager.appendModelChange(small.provider, small.id);
	sessionManager.appendThinkingLevelChange("low");
	sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
	const reply: AssistantMessage = {
		...fauxAssistantMessage("hello"),
		api: small.api,
		provider: "faux",
		model: "small",
	};
	sessionManager.appendMessage(reply);
	return sessionManager;
}

async function open(
	sessionManager: SessionManager,
	runtime: ModelRuntime,
	extra: Partial<CreateTestSessionOptions> = {},
) {
	const { session } = await createTestSession({
		cwd: tempDir,
		agentDir: tempDir,
		modelRuntime: runtime,
		sessionManager,
		resourceLoader: createTestResourceLoader(),
		...extra,
	});
	onTestFinished(() => session.dispose());
	return session;
}

const changes = (sessionManager: SessionManager) =>
	sessionManager
		.getBranch()
		.flatMap((entry) =>
			entry.type === "model_change"
				? [`model ${entry.provider}/${entry.modelId}`]
				: entry.type === "thinking_level_change"
					? [`thinking ${entry.thinkingLevel}`]
					: [],
		);

describe("resuming a session with another physical model", () => {
	it("records the model with the next prompt (opening writes nothing), and a later reopen restores it", async () => {
		const runtime = await runtimeWithFaux();
		const sessionManager = transcript(runtime);
		const large = runtime.getModel("faux", "large") as Model<string>;
		const resumed = await open(sessionManager, runtime, { model: large });
		expect(resumed.model).toMatchObject({ provider: "faux", id: "large" });
		expect(changes(sessionManager)).toEqual(["model faux/small", "thinking low"]);

		await resumed.prompt("again");
		await resumed.prompt("and again");
		// Recorded once, so the transcript (and archive's error grouping, which reads model_change) names the new model.
		expect(changes(sessionManager)).toEqual(["model faux/small", "thinking low", "model faux/large"]);

		const reopened = await open(sessionManager, runtime);
		expect(reopened.model).toMatchObject({ provider: "faux", id: "large" });
	});

	it("records nothing when the session reopens with the model it already uses", async () => {
		const runtime = await runtimeWithFaux();
		const sessionManager = transcript(runtime);
		const resumed = await open(sessionManager, runtime, { model: runtime.getModel("faux", "small")! });
		await resumed.prompt("again");
		expect(changes(sessionManager)).toEqual(["model faux/small", "thinking low"]);
	});
});
