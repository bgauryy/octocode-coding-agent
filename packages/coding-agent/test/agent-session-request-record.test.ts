import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Provider,
} from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager, type SessionMessageEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestSession } from "./helpers/session.ts";
import { testFeatures } from "./helpers/features.ts";
import { nativeFeatureSet } from "./helpers/native-features.ts";

/** A scripted Anthropic-API provider: it hands the payload it would send to `onPayload`, then answers from a script. */
function scriptedProvider(
	model: Model<"anthropic-messages">,
	hooks: { beforeReply?: (n: number, signal?: AbortSignal) => Promise<void> },
) {
	let calls = 0;
	const provider: Provider = {
		id: "anthropic",
		name: "Scripted",
		baseUrl: model.baseUrl,
		auth: { apiKey: { name: "key", resolve: async () => ({ auth: { apiKey: "k" }, source: "test" }) } },
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: (requested, context, options) => {
			const n = ++calls;
			const out = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `reply ${n}` }],
				api: requested.api,
				provider: requested.provider,
				model: requested.id,
				usage: {
					input: 10,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 12,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			void (async () => {
				await options?.onPayload?.(
					{
						system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
						messages: context.messages.map((each) => ({ role: each.role, content: `turn ${n}: ${each.role}` })),
					},
					requested,
				);
				try {
					await hooks.beforeReply?.(n, options?.signal);
				} catch {
					out.push({ type: "error", reason: "aborted", error: { ...message, content: [], stopReason: "aborted" } });
					return;
				}
				out.push({ type: "start", partial: message });
				out.push({ type: "done", reason: "stop", message });
			})();
			return out;
		},
	};
	return provider;
}

describe("AgentSession records requests, input origin and interrupts", () => {
	let tempDir: string;
	let agentDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `octocode-request-record-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});
	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	async function createSession(hooks: Parameters<typeof scriptedProvider>[1] = {}) {
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			nativeFeatures: nativeFeatureSet(),
			features: testFeatures([(api) => api.providers.register(scriptedProvider(model, hooks))]),
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory();
		const { session } = await createTestSession({
			cwd: tempDir,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});
		return { session, sessionManager };
	}

	const messageEntries = (sessionManager: SessionManager) =>
		sessionManager.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message");

	it("stores the request's layers on the assistant entry, one trace per request", async () => {
		const { session, sessionManager } = await createSession();
		await session.prompt("first");
		await session.prompt("second");
		const replies = messageEntries(sessionManager).filter((entry) => entry.message.role === "assistant");
		expect(replies).toHaveLength(2);
		const traces = replies.map((entry) => (entry.message as AssistantMessage).requestTrace);
		expect(traces[0]?.cacheMode).toBe("ephemeral");
		expect(traces[0]?.layers.map((layer) => [layer.kind, layer.role, layer.breakpoint])).toEqual([
			["system", undefined, true],
			["message", "system", undefined],
			["message", "user", undefined],
		]);
		// The second request sent more layers, and its trace is its own.
		expect(traces[1]?.layers.map((layer) => layer.kind)).toEqual([
			"system",
			"message",
			"message",
			"message",
			"message",
		]);
		expect(traces[1]?.layers[4].hash).not.toBe(traces[0]?.layers[2].hash);
		expect(JSON.stringify(traces)).not.toContain("first");
		session.dispose();
	});

	it("keeps the origin of each user message on its entry, and not on the message", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { session, sessionManager } = await createSession({
			beforeReply: async (n) => {
				if (n === 1) await gate;
			},
		});
		const running = session.prompt("typed text");
		await new Promise((resolve) => setTimeout(resolve, 20));
		await session.sendUserMessage("steer text", { deliverAs: "steer" });
		await session.sendUserMessage("follow text", { deliverAs: "followUp" });
		release?.();
		await running;
		await session.agent.waitForIdle();
		const users = messageEntries(sessionManager).filter((entry) => entry.message.role === "user");
		expect(users.map((entry) => entry.origin)).toEqual(["typed", "steer", "follow-up"]);
		expect(JSON.stringify(users.map((entry) => entry.message))).not.toContain("origin");
		session.dispose();
	});

	it("appends an octocode-interrupt entry when a turn is interrupted", async () => {
		const { session, sessionManager } = await createSession({
			beforeReply: (_n, signal) =>
				new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
		});
		const running = session.prompt("long task");
		await new Promise((resolve) => setTimeout(resolve, 20));
		await session.abort("interrupted");
		await running;
		const interrupts = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "octocode-interrupt");
		expect(interrupts).toHaveLength(1);
		expect(interrupts[0]).toMatchObject({ data: { reason: "interrupted", at: expect.any(String) } });
		session.dispose();
	});
});
