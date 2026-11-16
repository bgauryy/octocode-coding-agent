import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@octocodeai/octocode-agent-core";
import type { StreamFn } from "@octocodeai/octocode-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type Context,
	type SimpleStreamOptions,
} from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { generateBranchSummary, generateTurnPrefixSummary } from "../src/core/compaction/index.ts";
import { startEarlySummary } from "../src/octocode/compaction/early-summary.ts";
import { SessionManager, type SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model: Model<"anthropic-messages"> = {
	id: "m",
	name: "m",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};

type Kind = "stop" | "length" | "overflow";

function reply(kind: Kind): AssistantMessage {
	const base = fauxAssistantMessage("");
	const common = { ...base, api: model.api, provider: model.provider, model: model.id };
	if (kind === "overflow") {
		return {
			...common,
			content: [],
			stopReason: "error",
			errorMessage: "prompt is too long: 250000 tokens > 200000 maximum",
		};
	}
	return { ...common, content: [{ type: "text", text: "## Goal\nx\n## Where it stopped\ny" }], stopReason: kind };
}

function scripted(kinds: Kind[]): { streamFn: StreamFn; requests: () => number } {
	let count = 0;
	const streamFn: StreamFn = () => {
		count++;
		const message = reply(kinds.shift() ?? "stop");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			message.stopReason === "error"
				? stream.push({ type: "error", reason: "error", error: message })
				: stream.push({ type: "done", reason: message.stopReason as "stop" | "length", message }),
		);
		return stream;
	};
	return { streamFn, requests: () => count };
}

const turn = Array.from({ length: 4 }, (_, i) => ({
	role: "user" as const,
	content: `step ${i} ${"work ".repeat(50)}`,
	timestamp: i + 1,
}));

describe("deferred compaction findings", () => {
	it("retries a turn-prefix summary cut off at the output cap", async () => {
		const { streamFn, requests } = scripted(["length", "stop"]);
		const result = await generateTurnPrefixSummary(
			turn,
			model,
			"key",
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);
		expect(result.text).toContain("Goal");
		expect(requests()).toBe(2);
	});

	it("retries a branch summary cut off at the output cap", async () => {
		const { streamFn, requests } = scripted(["length", "stop"]);
		const entries = turn.map((message, i): SessionEntry => ({
			type: "message",
			id: `e${i}`,
			parentId: i ? `e${i - 1}` : null,
			timestamp: new Date(1).toISOString(),
			message,
		}));
		const result = await generateBranchSummary(entries, {
			model,
			apiKey: "key",
			signal: new AbortController().signal,
			streamFn,
		});
		expect(result.error).toBeUndefined();
		expect(result.summary).toContain("Goal");
		expect(requests()).toBe(2);
	});

	it("retries a branch summary the provider rejected as too large, dropping the oldest entries", async () => {
		const { streamFn, requests } = scripted(["overflow", "stop"]);
		const entries = turn.map((message, i): SessionEntry => ({
			type: "message",
			id: `e${i}`,
			parentId: i ? `e${i - 1}` : null,
			timestamp: new Date(1).toISOString(),
			message,
		}));
		const result = await generateBranchSummary(entries, {
			model,
			apiKey: "key",
			signal: new AbortController().signal,
			streamFn,
		});
		expect(result.error).toBeUndefined();
		expect(requests()).toBe(2);
	});
});

describe("silent overflow with a tool-call stop", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;
	let runAuto: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		tempDir = join(tmpdir(), `octocode-compaction-deferred-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const builtin = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const agent = new Agent({
			streamFn: streamSimple,
			initialState: { model: builtin, systemPrompt: "Test", tools: [] },
		});
		writeFileSync(join(tempDir, "settings.json"), JSON.stringify({ contextBudget: "full" }));
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		sessionManager = SessionManager.inMemory();
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		runAuto = vi
			.spyOn(session as unknown as { _runAutoCompaction: () => Promise<boolean> }, "_runAutoCompaction")
			.mockResolvedValue(true);
	});

	afterEach(() => {
		session.dispose();
		vi.restoreAllMocks();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	// Silent overflow is detected only for a `stop` reply, so a `toolUse` reply never reaches the retry branch: it takes
	// the threshold path, which keeps the completed reply.
	it("never omits and retries a completed tool-call reply", async () => {
		const live = session.model!;
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const reply: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "done", arguments: {} }],
			api: live.api,
			provider: live.provider,
			model: live.id,
			usage: {
				input: live.contextWindow + 50_000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: live.contextWindow + 50_010,
				cost: zero,
			},
			stopReason: "toolUse",
			timestamp: Date.now() + 1,
		};
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() });
		sessionManager.appendMessage(reply);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		await (session as unknown as { _checkCompaction: (m: AssistantMessage) => Promise<boolean> })._checkCompaction(
			reply,
		);
		expect(runAuto).not.toHaveBeenCalledWith("overflow", true, live);
		expect(runAuto).toHaveBeenCalledWith("threshold", false, live);
	});
});

describe("early summary requests", () => {
	it("stops the first request when a second prewarm replaces it, leaving the caller's signal alone", () => {
		const m = {
			provider: "p",
			id: "m",
			api: "anthropic-messages",
			maxTokens: 10_000,
			contextWindow: 200_000,
			reasoning: false,
		};
		const seen: SimpleStreamOptions[] = [];
		const api = {
			getThinkingLevel: () => "off",
			createUsageRecorder: () => () => undefined,
			getActiveTools: () => [],
			getHiddenDeclarations: () => [],
			getSettings: () => ({}),
			appendEntry: () => undefined,
		} as never;
		const sessionManager = {
			getSessionId: () => "sid",
			getHeader: () => null,
			getSessionFile: () => undefined,
			getBranch: () => [],
			buildSessionProjection: () => ({ entries: [], messages: [] }),
		};
		const ctx = {
			model: m,
			modelRegistry: {
				getCachePolicy: () => ({ options: {} }),
				streamSimple: (_model: unknown, _context: Context, options: SimpleStreamOptions) => {
					seen.push(options);
					return { result: () => new Promise(() => undefined) };
				},
			},
			sessionManager,
			hasUI: false,
			ui: { notify: () => undefined },
		} as never;
		const preparation = {
			firstKeptEntryId: "e3",
			tokensBefore: 150_000,
			messagesToSummarize: [{ role: "user", content: "x", timestamp: 1 }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings: { reserveTokens: 10_000 },
		};
		const first = new AbortController();
		const second = new AbortController();
		const event = (signal: AbortSignal) =>
			({ type: "session_compact_prewarm", preparation, branchEntries: [], signal }) as never;
		startEarlySummary(api, event(first.signal), ctx, false);
		startEarlySummary(api, event(second.signal), ctx, false);
		expect(seen).toHaveLength(2);
		expect(seen[0].signal?.aborted).toBe(true);
		expect(seen[1].signal?.aborted).toBe(false);
		expect(first.signal.aborted).toBe(false);
	});
});
