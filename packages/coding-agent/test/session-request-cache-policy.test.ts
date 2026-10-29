import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CacheRetention,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryModelsStore,
	type Model,
	normalizeContext,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SHORT_HISTORY_TTL_MS } from "../src/core/idle-cache-retention.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const START = 1_000_000_000;

describe("session request cache policy", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "octocode-request-cache-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** A session whose virtual model routes to an Anthropic-style model; `models` is the models.json content. */
	async function createFixture(models: object = {}) {
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(modelsPath, JSON.stringify(models));
		// The routed provider has its own key: a virtual route resolves the routed model's credentials.
		const credentials = AuthStorage.inMemory();
		await credentials.modify("claude-faux", async () => ({ type: "api_key", key: "faux-key" }));
		const runtime = await ModelRuntime.create({
			credentials,
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});
		const faux = fauxProvider({
			api: "anthropic-messages",
			provider: "claude-faux",
			models: [{ id: "claude-routed", contextWindow: 50_000, maxTokens: 5000, input: ["text"] }],
		});
		runtime.registerNativeProvider(faux.provider);
		runtime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			thinkingLevels: ["off"],
			route: () => ({ model: runtime.getModel("claude-faux", "claude-routed")!, thinkingLevel: "off" }),
		});
		await runtime.refresh({ allowNetwork: false });
		const virtual = runtime.getModel("router", "auto")!;
		const routed = runtime.getModel("claude-faux", "claude-routed")!;
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			model: virtual,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader: createTestResourceLoader(),
		});
		onTestFinished(() => session.dispose());
		const now = vi.spyOn(Date, "now").mockReturnValue(START);

		/** Send one request through the session's stream function at `at` and return the history retention it carried. */
		const send = async (model: Model<string>, at: number, options: SimpleStreamOptions = {}) => {
			let retention: CacheRetention | undefined;
			faux.setResponses([
				(_context, providerOptions) => {
					retention = providerOptions?.cacheRetention;
					return fauxAssistantMessage("ok");
				},
			]);
			now.mockReturnValue(at);
			const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });
			await (await session.agent.streamFunction(model, context, options)).result();
			return retention;
		};
		return { session, virtual, routed, send };
	}

	it("resolves a routed request's retention for the routed model, keeping caller options", async () => {
		const { virtual, send } = await createFixture({ providers: { "claude-faux": { cacheRetention: "long" } } });

		expect(await send(virtual, START)).toBe("long");
		expect(await send(virtual, START, { cacheRetention: "none" })).toBe("none");
	});

	it("moves a routed session's history to the one-hour tier after an idle gap", async () => {
		const { session, virtual, send } = await createFixture();
		const sessionRequest = { sessionId: session.sessionId };

		expect(await send(virtual, START, sessionRequest)).toBe("short");
		expect(await send(virtual, START + SHORT_HISTORY_TTL_MS + 1, sessionRequest)).toBe("long");
	});

	it("measures idle gaps and switches retention only for session requests", async () => {
		const { session, routed, send } = await createFixture();
		const sessionRequest = { sessionId: session.sessionId };
		const summaryRequest = { sessionId: `${session.sessionId}:summary` };

		expect(await send(routed, START, sessionRequest)).toBe("short");
		// A summary request after the session's history expired keeps the default retention and does not reset the gap.
		expect(await send(routed, START + SHORT_HISTORY_TTL_MS + 1, summaryRequest)).toBe("short");
		expect(await send(routed, START + SHORT_HISTORY_TTL_MS + 2, sessionRequest)).toBe("long");
	});

	it("does not let a summary request hide the session's idle gap", async () => {
		const { session, routed, send } = await createFixture();
		const sessionRequest = { sessionId: session.sessionId };

		await send(routed, START, sessionRequest);
		await send(routed, START + SHORT_HISTORY_TTL_MS - 1, { sessionId: "summary" });
		expect(await send(routed, START + 2 * SHORT_HISTORY_TTL_MS - 2, sessionRequest)).toBe("long");
	});
});
