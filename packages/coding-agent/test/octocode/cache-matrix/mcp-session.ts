/**
 * A real Octocode session (MCP feature on, a docs MCP server, default exposure that defers tools never called) on two
 * scripted providers: one whose transport has no in-place tool changes, and one that declares them (the Anthropic
 * `tool_addition` mode). Every request's transcript and stream options are recorded, as the model received them.
 */
import fs from "node:fs";
import path from "node:path";
import {
	createFauxCore,
	type fauxAssistantMessage,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import type { ExtensionFactory } from "../../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestSession } from "../../helpers/session.ts";
import { baseEnv, fixture, withEnv } from "../agent-context/capture.ts";

type Reply = ReturnType<typeof fauxAssistantMessage>;

export interface RecordedRequest {
	context: TranscriptContext;
	options: SimpleStreamOptions | undefined;
}

const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Runs `body` with a session on `plain` (no in-place tool changes) and `native` (tool changes) models. */
export async function withMcpSession<T>(
	body: (s: {
		requests: RecordedRequest[];
		/** Scripts the replies of one prompt; the session records every request they answer. */
		prompt: (text: string, replies: Reply[]) => Promise<void>;
		/** Switches the session to a model of the given provider. */
		use: (provider: "plain" | "native" | "plain-2") => Promise<void>;
	}) => Promise<T>,
): Promise<T> {
	const fx = fixture();
	try {
		const docs = path.join(import.meta.dirname, "..", "fixtures", "docs-mcp.mjs");
		fs.writeFileSync(
			path.join(fx.agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					octocode: { command: "false", enabled: false },
					docs: { command: process.execPath, args: [docs] },
				},
			}),
		);
		return await withEnv(baseEnv(fx), async () => {
			const cores = {
				plain: createFauxCore({
					provider: "faux-plain",
					models: [{ id: "plain-1", contextWindow: 200_000, maxTokens: 4_096 }],
				}),
				"plain-2": createFauxCore({
					provider: "faux-plain-2",
					models: [{ id: "plain-2", contextWindow: 200_000, maxTokens: 4_096 }],
				}),
				native: createFauxCore({
					provider: "faux-native",
					api: "anthropic-messages",
					models: [{ id: "native-1", contextWindow: 200_000, maxTokens: 4_096 }],
				}),
			};
			const providerOf =
				(key: keyof typeof cores): ExtensionFactory =>
				(api) => {
					const core = cores[key];
					api.registerProvider(core.models[0].provider, {
						name: core.models[0].provider,
						api: core.api,
						baseUrl: "http://127.0.0.1:0",
						apiKey: "test",
						models: core.models.map((model) => ({
							...model,
							promptCache: { short: 300, long: 3600 },
							cost: COST,
							...(key === "native"
								? { compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } }
								: {}),
						})),
						streamSimple: core.streamSimple,
					} as never);
				};
			const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
			const resourceLoader = new DefaultResourceLoader({
				cwd: fx.cwd,
				agentDir: fx.agentDir,
				settingsManager,
				extensionFactories: (["plain", "plain-2", "native"] as const).map((key) => ({
					name: `faux-${key}`,
					factory: providerOf(key),
				})),
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();
			const { session } = await createTestSession({
				cwd: fx.cwd,
				agentDir: fx.agentDir,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(fx.cwd),
			});
			try {
				await session.bindExtensions({ mode: "json", shutdownHandler: () => undefined } as never);
				const use = async (key: keyof typeof cores) => {
					const model = cores[key].models[0];
					await session.setModel(session.modelRuntime.getModel(model.provider, model.id)!);
				};
				await use("plain");
				const requests: RecordedRequest[] = [];
				const prompt = async (text: string, replies: Reply[]) => {
					const record = (reply: Reply) => (context: TranscriptContext, options?: SimpleStreamOptions) => {
						requests.push({ context: structuredClone(context), options: options && { ...options } });
						return reply;
					};
					for (const core of Object.values(cores)) core.setResponses(replies.map(record));
					await session.prompt(text);
				};
				return await body({ requests, prompt, use });
			} finally {
				session.dispose?.();
			}
		});
	} finally {
		fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
