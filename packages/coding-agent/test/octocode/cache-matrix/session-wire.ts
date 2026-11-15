/**
 * The session-to-wire bridge of the cache matrix: the transcripts and stream options a real Octocode session sent to its
 * (scripted) model are replayed through each real adapter's request builder, and what comes back is the payload and
 * headers that adapter would have sent. Nothing leaves the process.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryModelsStore,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { onTestFinished } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { nativeTo, wireRequest, type Wire, type WireCase } from "../../../../ai/test/cache-matrix/wire.ts";
import { createTestSession } from "../../helpers/session.ts";
import { createTestResourceLoader } from "../../utilities.ts";

/** One request a session sent: the transcript and the options the runtime resolved for it. */
export interface Recorded {
	context: TranscriptContext;
	options: SimpleStreamOptions;
}

/** The options that shape a request's cache behaviour; transport and callback fields stay behind. */
const CACHE_OPTIONS = [
	"sessionId",
	"promptCacheKey",
	"cacheRetention",
	"instructionCacheRetention",
	"instructionCacheBoundary",
	"instructionVolatileBoundary",
	"toolCacheBoundary",
	"roleVariantTools",
] as const;

export const cacheOptions = (options: SimpleStreamOptions = {}): StreamOptions =>
	Object.fromEntries(
		CACHE_OPTIONS.filter((key) => (options as Record<string, unknown>)[key] !== undefined).map((key) => [
			key,
			(options as Record<string, unknown>)[key],
		]),
	);

/** The request `entry` would send for `recorded`, the session's assistant turns taken as that model's own. */
export async function replay(recorded: Recorded, entry: WireCase): Promise<Wire> {
	const model = entry.model();
	const messages = nativeTo(model, structuredClone(recorded.context.messages));
	return wireRequest(entry, { messages } as TranscriptContext, cacheOptions(recorded.options), model);
}

export const replayAll = async (recorded: Recorded[], entry: WireCase): Promise<Wire[]> => {
	const wires: Wire[] = [];
	for (const request of recorded) wires.push(await replay(request, entry));
	return wires;
};

/** Pairs the recorded requests of `contexts` and `options` (as `headless()` returns them). */
export const recordings = (
	contexts: TranscriptContext[],
	options: Array<SimpleStreamOptions | undefined>,
): Recorded[] =>
	contexts.map((context, index) => ({ context: structuredClone(context), options: { ...options[index] } }));

/** A session on the bare scripted provider (no Octocode extension): prompts, forks and images, with every request recorded. */
export async function lightSessions() {
	const dir = mkdtempSync(join(tmpdir(), "octocode-cache-matrix-"));
	const sessions = join(dir, "sessions");
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		models: [{ id: "m", contextWindow: 100_000, maxTokens: 100, input: ["text", "image"] }],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const recorded: Recorded[] = [];
	const reply =
		(text: string) =>
		(context: TranscriptContext, options: SimpleStreamOptions | undefined): AssistantMessage => {
			recorded.push({ context: structuredClone(context), options: { ...options } });
			return fauxAssistantMessage(text);
		};
	/** Opens `manager` (a new session by default), prompts once and returns it. */
	async function prompt(
		manager: SessionManager,
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
	) {
		faux.setResponses([reply(`answer to ${text}`)]);
		const { session } = await createTestSession({
			cwd: dir,
			agentDir: dir,
			modelRuntime: runtime,
			sessionManager: manager,
			resourceLoader: createTestResourceLoader(),
		});
		onTestFinished(() => session.dispose());
		await session.prompt(text, images ? { images } : undefined);
	}
	const create = () => SessionManager.create(dir, sessions);
	/** A fork of `parent`'s current history, opened as its own session. */
	const fork = (parent: SessionManager) => {
		const source = SessionManager.open(parent.getSessionFile()!, sessions, dir);
		return SessionManager.open(source.createBranchedSession(source.getLeafId()!)!, sessions, dir);
	};
	return { recorded, prompt, create, fork, dir };
}
