import path from "node:path";
import { Agent } from "@octocodeai/octocode-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { AgentSession, type AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { getApplicationPort } from "../../../src/core/application/index.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { openAgentDb } from "../../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../../src/octocode/backlog/store.ts";
import { sharedWorkspaceWeb } from "../../../src/octocode/backlog/shared-web.ts";
import { WorkspaceRuntime } from "../../../src/octocode/workspace/runtime.ts";
import { startWorkspaceWeb } from "../../../src/octocode/workspace/server.ts";
import { createModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { fakeCtx, fakePi } from "../fake-pi.ts";

export async function workspaceAgent(root: string, label: string) {
	const directory = path.join(root, label);
	const auth = AuthStorage.create(path.join(directory, "auth.json"));
	await auth.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const registry = await createModelRegistry(auth, directory);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: getBuiltinModel("anthropic", "claude-sonnet-4-5"), systemPrompt: "Test", tools: [] },
		streamFn: (_model, context, options) => {
			const stream = createAssistantMessageEventStream();
			const last = [...context.messages].reverse().find((entry) => entry.role === "user");
			const text = typeof last?.content === "string" ? last.content
				: last?.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") ?? "";
			const answer: AssistantMessage = {
				role: "assistant", content: [{ type: "text", text: `${label} received: ${text}` }],
				api: "anthropic-messages", provider: "anthropic", model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: Date.now(),
			};
			const partial = { ...answer, content: [{ type: "text" as const, text: `${label} is responding…` }] };
			stream.push({ type: "start", partial });
			stream.push({ type: "text_delta", contentIndex: 0, delta: `${label} is responding…`, partial });
			const timer = setTimeout(() => stream.push({ type: "done", reason: "stop", message: answer }), 500);
			options?.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				stream.push({ type: "error", reason: "aborted", error: { ...answer, stopReason: "aborted" } });
			}, { once: true });
			return stream;
		},
	});
	const session = new AgentSession({
		agent, cwd: root, sessionManager: SessionManager.inMemory(root),
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		modelRuntime: getModelRuntime(registry), resourceLoader: createTestResourceLoader(),
	});
	const terminal: AgentSessionEvent[] = [];
	const application = getApplicationPort(session);
	application.subscribeNative((event) => terminal.push(event));
	const db = openAgentDb(path.join(root, "db"));
	const store = new BacklogStore(() => db, "shared-repo");
	const ctx = fakeCtx({ cwd: root });
	ctx.sessionManager.getSessionId = () => session.sessionId;
	const runtime = new WorkspaceRuntime(fakePi().pi, {
		application: () => application, database: () => db, members: () => [], traffic: () => [],
		tell: async () => ({}), stop: () => undefined,
	});
	const backlog = { store, actor: { id: label }, session: session.sessionId, repoName: label, repoRoot: root };
	const open = sharedWorkspaceWeb(async () => startWorkspaceWeb(backlog, () => {}, runtime.bind(ctx, backlog)), {
		OCTOCODE_AGENT_DB: path.join(root, "db"),
	});
	const web = await open(ctx, backlog, () => {});
	return { session, terminal, application, url: web.url, close: async () => {
		await web.close();
		await session.abort();
		session.dispose();
		db.close();
	} };
}
