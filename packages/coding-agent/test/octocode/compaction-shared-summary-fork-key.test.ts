import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryModelsStore,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { CHARS_PER_TOKEN } from "@octocodeai/octocode-ai/utils/estimate";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { sharedSummary } from "../../src/octocode/compaction/shared-summary.ts";
import { createTestSession } from "../helpers/session.ts";
import { createTestFeaturesResult, createTestResourceLoader } from "../utilities.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-summary-fork-key-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A fork of a session that already holds a conversation: its requests carry the parent's cache key. */
function forkOfConversation(): { fork: SessionManager; parentId: string } {
	const sessions = join(dir, "sessions");
	const parent = SessionManager.create(dir, sessions);
	for (let i = 0; i < 4; i++) {
		parent.appendMessage({
			role: "user",
			// About 6.7k tokens a question at the estimator's ratio, so four turns leave an earlier one to summarize.
			content: [{ type: "text", text: `question ${i} ${"x".repeat(Math.round((20_000 * CHARS_PER_TOKEN) / 3))}` }],
			timestamp: i,
		});
		parent.appendMessage(fauxAssistantMessage(`answer ${i}`));
	}
	const source = SessionManager.open(parent.getSessionFile()!, sessions, dir);
	const forkPath = source.createBranchedSession(source.getLeafId()!)!;
	return { fork: SessionManager.open(forkPath, sessions, dir), parentId: parent.getSessionId() };
}

it("sends the shared summary request with the cache key the session's own requests carry, on a fork", async () => {
	const { fork, parentId } = forkOfConversation();
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ models: [{ id: "m", contextWindow: 40_000, maxTokens: 1_000, input: ["text"] }] });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });

	const featuresResult = await createTestFeaturesResult(
		[
			{
				name: "summary",
				owner: "native",
				factory: (api) => {
					api.bus.on("session_before_compact", async (event, ctx) => {
						const result = await sharedSummary(api, event, ctx, ctx.model!, "Keep the objective.");
						return result ? { compaction: result } : undefined;
					});
				},
			},
		],
		dir,
	);
	const { session } = await createTestSession({
		cwd: dir,
		agentDir: dir,
		modelRuntime: runtime,
		sessionManager: fork,
		resourceLoader: createTestResourceLoader({ featuresResult }),
	});
	try {
		await session.bindFeatures({
			mode: "json",
			uiContext: { confirm: async () => true, notify: () => undefined } as never,
			shutdownHandler: () => undefined,
		} as never);
		const main: Array<SimpleStreamOptions | undefined> = [];
		const summary: Array<SimpleStreamOptions | undefined> = [];
		faux.setResponses([
			(_context: unknown, options: SimpleStreamOptions | undefined): AssistantMessage => {
				main.push(options);
				return fauxAssistantMessage("main reply");
			},
			(_context: unknown, options: SimpleStreamOptions | undefined): AssistantMessage => {
				summary.push(options);
				return fauxAssistantMessage("## Goal\nKeep the objective.");
			},
		] as never[]);
		await session.prompt("hello");
		await session.compact();

		expect(fork.getSessionId()).not.toBe(parentId);
		expect(main).toHaveLength(1);
		expect(summary).toHaveLength(1);
		const key = (options: SimpleStreamOptions | undefined) => options?.promptCacheKey ?? options?.sessionId;
		expect(key(main[0])).toBe(parentId);
		expect(key(summary[0])).toBe(key(main[0]));
	} finally {
		session.dispose();
	}
});
