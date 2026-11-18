import fs from "node:fs";
import path from "node:path";
import type { Usage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { formatCost, formatTokenUsage } from "../../src/octocode/shared/format.ts";
import { row as panelRow } from "../../src/octocode/team/panel/cells.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { registerFooter } from "../../src/octocode/ui/footer.ts";
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

const reply = (spent: Usage) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "ok" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: spent,
	stopReason: "stop" as const,
	timestamp: 2,
});

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

/**
 * The agent list and the footer total the same session. It holds two replies, a compaction summary request (the default
 * compaction records it as a `usage` entry) and a cache refresh; each is counted once on both surfaces.
 *
 *                       input  cacheRead cacheWrite output cost
 *   reply 1             1000   9000      0          100    0.10
 *   compaction_attempt  2000   0         8000       500    0.30
 *   cache_warm          0      10000     0          1      0.02
 *   reply 2             500    19000     500        200    0.20
 */
describe("an agent's row counts what the footer counts", () => {
	it("includes the compaction summary request and the cache refresh, each once", async () => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const sm = SessionManager.inMemory();
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
		registerCollab(fake.api, team);
		registerFooter(fake.api);
		const ctx = fakeCtx({ cwd }) as unknown as Record<string, any>;
		ctx.model = { provider: "anthropic", id: "claude-sonnet-4-5", reasoning: false, contextWindow: 200_000 };
		ctx.getContextUsage = () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 });
		ctx.sessionManager.getEntries = () => sm.getEntries();
		await fake.emit("session_start", {}, ctx);
		const component = ctx.ui.footer({ requestRender: () => undefined }, theme, {
			getGitBranch: () => null,
			getFeatureStatuses: () => new Map(),
			onBranchChange: () => () => undefined,
		});
		const me = team.join("spend");

		const first = reply(usage(1000, 9000, 0, 100, 0.1));
		sm.appendMessage(first);
		await fake.emit("message_end", { message: first }, ctx);

		sm.appendUsage("compaction_attempt", "anthropic", "claude-sonnet-4-5", usage(2000, 0, 8000, 500, 0.3));
		const kept = sm.appendMessage({ role: "user", content: "next", timestamp: 3 });
		const compactionId = sm.appendCompaction("summary", kept, 10_000);
		const compactionEntry = sm.getEntries().find((entry) => entry.id === compactionId);
		await fake.emit("session_compact", { compactionEntry, fromFeature: false }, ctx);

		sm.appendUsage("cache_warm", "anthropic", "claude-sonnet-4-5", usage(0, 10_000, 0, 1, 0.02));
		const second = reply(usage(500, 19_000, 500, 200, 0.2));
		sm.appendMessage(second);
		await fake.emit("message_end", { message: second }, ctx);
		await fake.emit("agent_end", { messages: [] }, ctx);

		// input + cache writes: 3500 + 8500 uncached prompt tokens; cacheRead 38000; output 801; cost 0.62.
		const footer = (component.render(200) as string[]).join("\n");
		expect(footer).toContain("≈$0.62");
		const row = formatTokenUsage(me);
		expect(row).toBe("↑12k +38k cached ↓801");
		// The footer counts the same new prompt tokens and output; the 38k cache reads show only as the share (38k of 50k).
		expect(footer).toContain("12.8k tok (↑12k ↓801) · 76% cached");
		expect(footer.match(/Σ/g)).toHaveLength(1);
		expect(formatCost(me)).toBe("≈$0.62");
		// The agents panel draws the same figures in the agent's row.
		expect(panelRow({ member: me, depth: 1 }, "child", Date.now(), theme)).toMatchObject({
			tokens: "12.8k tok",
			cached: "76% cached",
			cost: "≈$0.62",
		});
		team.stop();
	});
});
