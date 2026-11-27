import { afterEach, describe, expect, it } from "vitest";
import { installSpendCapture, type SpendCapture } from "../../src/core/spend-capture.ts";
import { runRunnerChild } from "../../src/octocode/subagents/runner-child.ts";
import type { RunnerReply, Runners } from "../../src/octocode/subagents/runner-port.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

type Spent = Parameters<SpendCapture["spent"]>[0];

/** Installs a capture that keeps every `spent` request; the returned list fills as the runner reports. */
function captured(): { spent: Spent[]; remove: () => void } {
	const spent: Spent[] = [];
	const remove = installSpendCapture({
		billing: () => undefined,
		appended: () => undefined,
		spent: (r) => spent.push(r),
	});
	return { spent, remove };
}

let remove: (() => void) | undefined;
afterEach(() => remove?.());

async function run(reply: RunnerReply, model?: string) {
	const runners: Runners = { ids: ["codex"], turn: async () => reply };
	const cwd = tmp("octocode-runner-spend-");
	const outcome = await runRunnerChild(runners, {
		runner: "codex",
		...(model ? { model } : {}),
		task: "Check arithmetic",
		cwd,
		identity: { id: "spend-child", goal: "Check arithmetic", scratch: cwd },
		signal: undefined,
		onProgress: () => undefined,
		ctx: fakeCtx({ cwd }),
	});
	return { cwd, outcome };
}

describe("an external runner's turn records its spend once", () => {
	it("captures a metered turn with the runner, model, tokens, cost and billing", async () => {
		const capture = captured();
		remove = capture.remove;
		const { cwd, outcome } = await run(
			{
				text: "done: verified arithmetic",
				stopReason: "end_turn",
				usage: { inputTokens: 1200, outputTokens: 300, cachedReadTokens: 800, cachedWriteTokens: 0, totalTokens: 2300 },
				cost: 0.42,
				billing: "metered",
			},
			"gpt-6.1",
		);

		expect(capture.spent).toHaveLength(1);
		const [request] = capture.spent;
		expect(request).toMatchObject({ cwd, kind: "runner", provider: "codex", model: "gpt-6.1", billing: "metered" });
		expect(request.usage).toBe(outcome.usage);
		expect(request.usage.output).toBe(300);
		expect(request.usage.cacheRead).toBe(800);
		expect(request.usage.cost.total).toBe(0.42);
	});

	it("names the runner as the model when none was chosen, and a plan's turn costs no money", async () => {
		const capture = captured();
		remove = capture.remove;
		await run({
			text: "done: verified arithmetic",
			stopReason: "end_turn",
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			cost: 1.5,
			billing: "plan",
		});

		expect(capture.spent).toHaveLength(1);
		expect(capture.spent[0]).toMatchObject({ provider: "codex", model: "codex", billing: "plan" });
		expect(capture.spent[0].usage.cost.total).toBe(0);
	});
});
