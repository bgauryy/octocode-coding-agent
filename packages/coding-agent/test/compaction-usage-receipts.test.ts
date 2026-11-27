import { expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { computeCacheMetrics } from "../src/core/cache-stats.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const usage = {
	input: 10,
	output: 2,
	cacheRead: 4,
	cacheWrite: 0,
	cacheWrite1h: 0,
	reasoning: 1,
	totalTokens: 16,
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 },
};
const model = { provider: "test", id: "test", api: "anthropic-messages", maxTokens: 10000, contextWindow: 200000 };
const preparation = {
	firstKeptEntryId: "keep",
	messagesToSummarize: [{ role: "user", content: "old", timestamp: 0 }],
	turnPrefixMessages: [{ role: "user", content: "current", timestamp: 1 }],
	isSplitTurn: true,
	tokensBefore: 100,
	fileOps: { read: new Set(), written: new Set(), edited: new Set() },
	settings: { reserveTokens: 1000, keepRecentTokens: 10 },
};
const runDefault = (
	AgentSession.prototype as unknown as {
		_runDefaultCompaction: (
			preparation: unknown,
			model: unknown,
			signal: AbortSignal,
			reason: string,
		) => Promise<{ usage?: unknown }>;
	}
)._runDefaultCompaction;

it.each([false, true])("preserves every split summary attempt when the second fails=%s", async (fail) => {
	const manager = SessionManager.inMemory();
	const events: unknown[] = [];
	let calls = 0;
	const session = {
		sessionManager: manager,
		_getSummarizationRequestAuth: async () => ({ model, thinkingLevel: "off" }),
		settingsManager: { getRetrySettings: () => ({ enabled: false, maxRetries: 0 }) },
		_summarizationRetryCallbacks: () => undefined,
		_emit: (event: unknown) => events.push(event),
		agent: {
			streamFunction: vi.fn(async () => {
				calls++;
				const message = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: 0,
					content: [{ type: "text", text: "summary" }],
					usage: { ...usage },
					stopReason: fail && calls === 2 ? "error" : "stop",
					errorMessage: fail && calls === 2 ? "failed summary" : undefined,
				};
				return { result: async () => message };
			}),
		},
	};
	const pending = runDefault.call(session, preparation, model, new AbortController().signal, "manual");
	if (fail) await expect(pending).rejects.toThrow();
	else expect((await pending).usage).toBeUndefined();
	const receipts = manager.getEntries().filter((entry) => entry.type === "usage");
	expect(receipts).toHaveLength(2);
	expect(receipts.map((entry) => entry.usage)).toEqual([usage, usage]);
	expect(events).toHaveLength(2);
	expect(computeCacheMetrics(manager.getEntries()).compaction).toMatchObject({ requests: 2, cost: 6 });
	expect(computeCacheMetrics(manager.getEntries()).other.requests).toBe(0);
});
