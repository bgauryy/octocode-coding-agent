import { describe, expect, it } from "vitest";
import { AcpOutput } from "../../../acp/src/client/output.ts";
import { acpClientHost } from "../../src/octocode/external/acp-host.ts";
import { addReply, emptyTotals } from "../../src/octocode/shared/util.ts";
import { runRunnerChild } from "../../src/octocode/subagents/runner-child.ts";
import type { Runners } from "../../src/octocode/subagents/runner-port.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

describe("external runner token accounting", () => {
	it.each([
		{
			runner: "gemini",
			inputTokens: 174490,
			outputTokens: 891,
			cachedReadTokens: 139406,
			cachedWriteTokens: 0,
			totalTokens: 175381,
			uncached: 35084,
			prompt: 174490,
		},
		{
			runner: "claude-code",
			inputTokens: 6,
			outputTokens: 1521,
			cachedReadTokens: 48309,
			cachedWriteTokens: 8473,
			totalTokens: 58309,
			uncached: 6,
			prompt: 56788,
		},
		{
			runner: "codex",
			inputTokens: 3539,
			outputTokens: 125,
			cachedReadTokens: 11520,
			cachedWriteTokens: 0,
			totalTokens: 15184,
			uncached: 3539,
			prompt: 15059,
		},
		{
			runner: "opencode",
			inputTokens: 15,
			outputTokens: 366,
			cachedReadTokens: 20884,
			cachedWriteTokens: 5635,
			totalTokens: 26900,
			uncached: 15,
			prompt: 26534,
		},
	])("keeps $runner ACP, child and displayed totals consistent", async ({ runner, uncached, prompt, ...counts }) => {
		const output = new AcpOutput(acpClientHost.saveOutput);
		const reply = output.reply({ stopReason: "end_turn", usage: counts } as never);
		const runners: Runners = { ids: [runner], turn: async () => ({ ...reply, text: "done: verified arithmetic" }) };
		const cwd = tmp("octocode-runner-usage-");
		const result = await runRunnerChild(runners, {
			runner,
			task: "Check arithmetic",
			cwd,
			identity: { id: "usage-child", goal: "Check arithmetic", scratch: cwd },
			signal: undefined,
			onProgress: () => undefined,
			ctx: fakeCtx({ cwd }),
		});
		expect(result.usage.input).toBe(uncached);
		expect(result.usage.cacheRead).toBe(counts.cachedReadTokens);
		expect(result.usage.cacheWrite).toBe(counts.cachedWriteTokens);
		expect(result.usage.totalTokens).toBe(counts.totalTokens);
		const details = emptyTotals();
		addReply(details, result.usage, false);
		expect(details.input).toBe(prompt);
		expect(details.output).toBe(counts.outputTokens);
		expect(details.input + details.output).toBe(counts.totalTokens);
	});
});
