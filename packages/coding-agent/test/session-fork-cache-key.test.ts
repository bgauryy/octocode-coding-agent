// A fork's requests carry the cache key of the session it was forked from, so an OpenAI model that routes by
// prompt_cache_key (before GPT-5.6) can reuse the parent's cached prefix. Unrelated sessions keep separate keys.
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
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestSession } from "./helpers/session.ts";
import { createTestResourceLoader } from "./utilities.ts";

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "octocode-fork-cache-key-"));
});
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

const sessionsDir = () => join(tempDir, "sessions");

async function setup() {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({ models: [{ id: "m", contextWindow: 10_000, maxTokens: 100, input: ["text"] }] });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const seen: Array<SimpleStreamOptions | undefined> = [];
	const answer =
		(text: string) =>
		(_c: unknown, options: SimpleStreamOptions | undefined): AssistantMessage => {
			seen.push(options);
			return fauxAssistantMessage(text);
		};
	return { runtime, faux, seen, answer };
}

async function prompt(
	sessionManager: SessionManager,
	runtime: ModelRuntime,
	faux: { setResponses: (r: never[]) => void },
	step: unknown,
) {
	faux.setResponses([step as never]);
	const { session } = await createTestSession({
		cwd: tempDir,
		agentDir: tempDir,
		modelRuntime: runtime,
		sessionManager,
		resourceLoader: createTestResourceLoader(),
	});
	onTestFinished(() => session.dispose());
	await session.prompt("hello");
	return session;
}

describe("prompt cache key across a fork", () => {
	it("keeps the parent's key on a fork and on a fork of that fork", async () => {
		const { runtime, faux, seen, answer } = await setup();
		const parent = SessionManager.create(tempDir, sessionsDir());
		await prompt(parent, runtime, faux, answer("one"));
		const parentId = parent.getSessionId();
		const parentKey = seen[0]?.promptCacheKey ?? seen[0]?.sessionId;
		expect(parentKey).toBe(parentId);

		// createBranchedSession switches its manager to the new file, so branch from a reopened copy.
		const source = SessionManager.open(parent.getSessionFile()!, sessionsDir(), tempDir);
		const forkPath = source.createBranchedSession(source.getLeafId()!)!;
		const fork = SessionManager.open(forkPath, sessionsDir(), tempDir);
		expect(fork.getSessionId()).not.toBe(parentId);
		await prompt(fork, runtime, faux, answer("two"));
		expect(seen[1]?.promptCacheKey).toBe(parentKey);

		const forkSource = SessionManager.open(fork.getSessionFile()!, sessionsDir(), tempDir);
		const grandPath = forkSource.createBranchedSession(forkSource.getLeafId()!)!;
		const grand = SessionManager.open(grandPath, sessionsDir(), tempDir);
		await prompt(grand, runtime, faux, answer("three"));
		expect(seen[2]?.promptCacheKey).toBe(parentKey);
	});

	it("keeps the key after the session is resumed from disk", async () => {
		const { runtime, faux, seen, answer } = await setup();
		const original = SessionManager.create(tempDir, sessionsDir());
		await prompt(original, runtime, faux, answer("one"));
		const key = seen[0]?.promptCacheKey ?? seen[0]?.sessionId;
		expect(key).toBe(original.getSessionId());
		const resumed = SessionManager.open(original.getSessionFile()!, sessionsDir(), tempDir);
		expect(resumed.getSessionId()).toBe(original.getSessionId());
		await prompt(resumed, runtime, faux, answer("two"));
		expect(seen[1]?.promptCacheKey ?? seen[1]?.sessionId).toBe(key);
	});

	it("gives an unrelated session its own key", async () => {
		const { runtime, faux, seen, answer } = await setup();
		const a = SessionManager.create(tempDir, sessionsDir());
		const b = SessionManager.create(tempDir, sessionsDir());
		await prompt(a, runtime, faux, answer("one"));
		await prompt(b, runtime, faux, answer("two"));
		expect(seen[0]?.promptCacheKey ?? seen[0]?.sessionId).toBe(a.getSessionId());
		expect(seen[1]?.promptCacheKey ?? seen[1]?.sessionId).toBe(b.getSessionId());
	});
});
