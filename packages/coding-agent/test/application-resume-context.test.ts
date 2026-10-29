import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@octocodeai/octocode-ai/compat";
import { afterEach, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { ApplicationService } from "../src/core/application/service.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function open(
	dir: string,
	faux: ReturnType<typeof registerFauxProvider>,
	sessionManager: SessionManager,
	appendSystemPrompt?: string[],
) {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(dir, "models.json") });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [{ ...model, baseUrl: model.baseUrl }],
	});
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		resourceLoaderOptions: { appendSystemPrompt, noSkills: true, noPromptTemplates: true, noThemes: true },
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager, model });
	await session.bindExtensions({});
	return session;
}

it("keeps the transcript when the first turn after resuming rebuilds a context holding a new custom message", async () => {
	const dir = join(tmpdir(), `resume-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const faux = registerFauxProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("one"),
		fauxAssistantMessage("two"),
	]);
	cleanups.push(() => {
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	});

	const original = await open(dir, faux, SessionManager.create(dir));
	await original.prompt("hello");
	const file = original.sessionFile as string;
	original.dispose();

	const resumed: AgentSession = await open(dir, faux, SessionManager.open(file), ["changed prompt"]);
	cleanups.push(() => resumed.dispose());
	const service = new ApplicationService(resumed);
	cleanups.push(() => service.dispose());
	const types: string[] = [];
	service.subscribe((event) => types.push(event.type));
	service.connect();
	const ids = service.getSnapshot().messages.map((message) => message.id);

	// A custom message is created with the time of its creation and persisted a moment later.
	await resumed.sendCustomMessage(
		{ customType: "note", content: "hello note", display: true },
		{ deliverAs: "nextTurn" },
	);
	await new Promise((resolve) => setTimeout(resolve, 5));
	await resumed.prompt("resumed");

	expect(types).not.toContain("session.reset");
	const snapshot = service.getSnapshot();
	expect(snapshot.messages.map((message) => message.id).slice(0, ids.length)).toEqual(ids);
	expect(snapshot.messages.map((message) => message.text)).toContain("hello note");
	const [live] = resumed.messages.filter((message) => message.role === "custom");
	const [entry] = resumed.sessionManager.getEntries().filter((candidate) => candidate.type === "custom_message");
	expect(new Date(entry.timestamp).getTime()).toBe(live.timestamp);
});
