import path from "node:path";
import type { Usage } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { computeSessionStats } from "../../src/core/session-stats.ts";
import { closeSharedAgentDb, sharedAgentDb } from "../../src/octocode/agentdb/db.ts";
import { registerSessions } from "../../src/octocode/sessions/register.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import { entryMessage } from "../../src/octocode/shared/util.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const usage = (input: number, cacheRead: number, cacheWrite: number, output: number, total: number): Usage => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const saved = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
beforeEach(() => {
	process.env.OCTOCODE_HOME = tmp();
	delete process.env.OCTOCODE_AGENT_DB;
});
afterEach(() => {
	closeSharedAgentDb();
	if (saved.home === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = saved.home;
	if (saved.db !== undefined) process.env.OCTOCODE_AGENT_DB = saved.db;
});

/** The index's totals are /session's: a reply, a compaction summary request, a cache refresh and a background subagent report. */
describe("the session index totals what /session totals", () => {
	for (const replay of [true, false]) {
		it(replay ? "when it replays a saved session at start" : "as the session runs", async () => {
			const cwd = tmp();
			const sm = SessionManager.create(cwd, path.join(tmp(), "sessions"));
			const fake = fakeHost();
			const ctx = fakeCtx({ cwd, mode: "tui" }) as unknown as Record<string, any>;
			ctx.sessionManager = sm;
			registerSessions(fake.api, { commands: new Subcommands(), isSubagent: false });
			const append = () => {
				sm.appendMessage({ role: "user", content: "go", timestamp: 1 });
				sm.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: usage(1000, 9000, 0, 100, 0.1),
					stopReason: "stop",
					timestamp: 2,
				});
				sm.appendUsage("compaction_attempt", "anthropic", "claude-sonnet-4-5", usage(2000, 0, 8000, 500, 0.3));
				sm.appendUsage("cache_warm", "anthropic", "claude-sonnet-4-5", usage(0, 10_000, 0, 1, 0.02));
				const kept = sm.appendMessage({ role: "user", content: "next", timestamp: 3 });
				sm.appendCompaction("summary", kept, 10_000);
				sm.appendCustomMessageEntry("octocode-agent-result", "done", true, {
					usage: usage(100, 900, 0, 50, 0.05),
					unpriced: false,
				});
			};
			if (replay) append();
			await fake.emit("session_start", { reason: "startup" }, ctx);
			if (!replay) {
				append();
				// A running session reports each reply and each background report as it ends; the rest is recorded as an entry.
				for (const entry of sm.getEntries()) {
					const message = entryMessage(entry);
					if (message) await fake.emit("message_end", { type: "message_end", message }, ctx);
				}
				await fake.emit(
					"session_compact",
					{ type: "session_compact", compactionEntry: sm.getEntries().find((e) => e.type === "compaction") },
					ctx,
				);
			}
			await fake.emit("agent_end", { messages: [] }, ctx);
			const stats = computeSessionStats(sm, { sessionFile: undefined, sessionId: sm.getSessionId() });
			const row = new SessionIndex(sharedAgentDb()).get(sm.getSessionId());
			expect(row?.cost).toBeCloseTo(stats.cost, 10);
			expect(row?.cost).toBeCloseTo(0.47, 10);
			expect(row?.tokens).toBe(stats.tokens.total);
		});
	}
});
