import { type AssistantMessage, createFauxCore, type TranscriptContext } from "@octocodeai/octocode-ai";
import type { FeatureRegister, ToolDefinition } from "../../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import type { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestSession } from "../../helpers/session.ts";
import type { Fixture } from "../agent-context/capture.ts";
import { testFeatures } from "../../helpers/features.ts";
import { nativeFeatureSet } from "../../helpers/native-features.ts";

/**
 * A real main session (native tools, the Octocode extension, bundled skills, the Octocode MCP server) on the scripted model
 * `faux/replay`, as `scriptedSession` builds one, with three differences a replay needs: the model's window is chosen by
 * the caller, replies stream in large deltas (a recorded reply of 40 kB would otherwise be ten thousand deltas), and the
 * recorded tools replace the session's tools of the same name.
 */
export async function replaySession(
	fx: Fixture,
	options: {
		sessionManager: SessionManager;
		contextWindow: number;
		tools: ToolDefinition[];
		respond: (context: TranscriptContext) => Promise<AssistantMessage>;
		/** Tokens per streamed delta. */
		deltaTokens?: number;
	},
) {
	const delta = options.deltaTokens ?? 1_024;
	const faux = createFauxCore({
		provider: "faux",
		models: [{ id: "replay", contextWindow: options.contextWindow, maxTokens: 16_384 }],
		tokenSize: { min: delta, max: delta },
	});
	const provider: FeatureRegister = (api) => {
		api.providers.register("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model) => ({
				...model,
				promptCache: { short: 300, long: 3600 },
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: fx.cwd,
		agentDir: fx.agentDir,
		settingsManager,
		nativeFeatures: nativeFeatureSet(),
		features: testFeatures([{ name: "faux-provider", factory: provider }]),
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createTestSession({
		cwd: fx.cwd,
		agentDir: fx.agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: options.sessionManager,
		customTools: options.tools,
	});
	try {
		await session.bindFeatures({ mode: "json", shutdownHandler: () => undefined } as never);
		await session.setModel(session.modelRuntime.getModel("faux", "replay")!);
	} catch (error) {
		session.dispose?.();
		throw error;
	}
	// Every request, however many the replay makes, goes to the replay model: the queue is topped up as it drains, ahead
	// of requests that start before an earlier one is answered.
	const batch = () => Array.from({ length: 64 }, () => answer);
	const answer = (context: TranscriptContext) => {
		if (faux.getPendingResponseCount() < 32) faux.appendResponses(batch());
		return options.respond(context);
	};
	faux.setResponses(batch());
	return { session, faux };
}
