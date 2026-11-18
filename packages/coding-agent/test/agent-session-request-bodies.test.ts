import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	describePayloadLayers,
	type Model,
	normalizeContext,
	type Provider,
} from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../../ai/src/api/anthropic-messages.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { readsMessagesOnly } from "../src/core/features/runner/clone-messages.ts";
import type { FeatureRegister } from "../src/core/features/types.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager, type SessionMessageEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestSession } from "./helpers/session.ts";
import { testFeatures } from "./helpers/features.ts";
import { nativeFeatureSet } from "./helpers/native-features.ts";

/**
 * What a provider receives must not depend on how Octocode got there: handing read-only `context` handlers the
 * transcript itself instead of a copy, and describing each request through the session's layer memo, leave every
 * request body byte for byte as the copying path builds it (the prompt cache matches on those bytes), and each reply's
 * trace as the full description of its body.
 */

/** An Anthropic provider that builds the real request body, records it, and answers from a script. */
function recordingProvider(model: Model<"anthropic-messages">, bodies: string[]): Provider {
	return {
		id: "anthropic",
		name: "Recording",
		baseUrl: model.baseUrl,
		auth: { apiKey: { name: "key", resolve: async () => ({ auth: { apiKey: "k" }, source: "test" }) } },
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: (requested, context, options) => {
			const n = bodies.length + 1;
			const out = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `think ${n}`, thinkingSignature: `sig${n}` },
					{ type: "text", text: `reply ${n} ${"words ".repeat(n)}` },
				],
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
				timestamp: 1_000 + n,
			};
			void (async () => {
				const captured = await streamAnthropic(requested as Model<"anthropic-messages">, normalizeContext(context), {
					...options,
					apiKey: "test-key",
					onPayload: async (params) => {
						const sent = (await options?.onPayload?.(params, requested)) ?? params;
						bodies.push(JSON.stringify(sent));
						throw new Error("request captured");
					},
				}).result();
				if (captured.errorMessage !== "request captured")
					throw new Error(captured.errorMessage ?? "Request not captured");
				out.push({ type: "start", partial: message });
				out.push({ type: "done", reason: "stop", message });
			})();
			return out;
		},
	};
}

describe("request bodies with read-only context handlers", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `octocode-request-bodies-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	});
	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	async function run(copying: boolean) {
		const dir = join(tempDir, copying ? "copying" : "reading");
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const bodies: string[] = [];
		const settingsManager = SettingsManager.create(dir, agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const handlers: FeatureRegister = (api) => {
			api.providers.register(recordingProvider(model, bodies));
			// The built-in kind: reads, and returns a shorter list on some requests.
			api.bus.on(
				"context",
				readsMessagesOnly(async (event) => {
					const kept = event.messages.filter((message) => !(message.role === "user" && message.timestamp === -1));
					return kept.length === event.messages.length ? { messages: [...kept] } : { messages: kept };
				}),
			);
			api.bus.on(
				"context",
				readsMessagesOnly(async () => undefined),
			);
			// A handler that may edit: the transcript is copied before it, as every handler's was before.
			if (copying) api.bus.on("context", async () => undefined);
		};
		const resourceLoader = new DefaultResourceLoader({
			cwd: dir,
			agentDir,
			settingsManager,
			nativeFeatures: nativeFeatureSet(),
			features: testFeatures([handlers]),
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory();
		const { session } = await createTestSession({
			cwd: dir,
			agentDir,
			model,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});
		for (let turn = 1; turn <= 6; turn++) await session.prompt(`turn ${turn}: ${"context ".repeat(turn)}`);
		const traces = sessionManager
			.getEntries()
			.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "assistant")
			.map((entry) => (entry.message as AssistantMessage).requestTrace);
		session.dispose();
		return { bodies, traces };
	}

	it("sends the bytes the copying path sends, and traces each body as the full description does", async () => {
		const reading = await run(false);
		const copying = await run(true);
		expect(reading.bodies).toHaveLength(6);
		expect((JSON.parse(reading.bodies[5]) as { messages: unknown[] }).messages.length).toBeGreaterThanOrEqual(11);
		expect(reading.bodies[5]).toContain("turn 6");
		// Bodies differ only by the system prompt's working directory, the same length in both runs.
		const normalize = (body: string) =>
			body.replaceAll(join(tempDir, "reading"), "<dir>").replaceAll(join(tempDir, "copying"), "<dir>");
		expect(reading.bodies.map(normalize)).toEqual(copying.bodies.map(normalize));
		for (const run of [reading, copying]) {
			expect(run.traces.map((trace) => JSON.stringify(trace))).toEqual(
				run.bodies.map((body) => JSON.stringify(describePayloadLayers("anthropic-messages", JSON.parse(body)))),
			);
		}
	});
});
