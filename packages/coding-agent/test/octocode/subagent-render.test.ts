import { describe, expect, it } from "vitest";
import {
	doneSummary,
	renderAgentCall,
	renderAgentMessage,
	renderAgentResult,
} from "../../src/octocode/subagents/render.ts";
import { rendered, theme } from "./fake-pi.ts";
import type { RunDetails } from "../../src/octocode/subagents/run-types.ts";
import { fenceUntrusted } from "../../src/octocode/shared/fence.ts";

const ctx = (extra: Record<string, unknown> = {}) =>
	({
		args: {},
		lastComponent: undefined,
		isPartial: false,
		isError: false,
		expanded: false,
		state: {},
		...extra,
	}) as never;
const details = (extra: Partial<RunDetails> = {}): RunDetails => ({
	id: "general-0001",
	profile: "general",
	goal: "audit auth token refresh",
	toolCalls: 2,
	activity: ["→ bash ls", "→ read a.ts"],
	input: 1_500,
	cacheRead: 0,
	output: 500,
	cost: 0,
	unpriced: false,
	startedAt: 0,
	status: "done",
	...extra,
});

describe("subagent renderers", () => {
	it.each([false, true])(
		"shows foreground fenced reports and host footers without fence markers (error=%s)",
		(isError) => {
			const content = fenceUntrusted("Subagent general-0001 finished", "Child answer", { footer: "Host follow-up" });
			const text = rendered(
				renderAgentResult(
					{ content: [{ type: "text", text: content }], details: details() },
					{ isPartial: false, expanded: true },
					theme,
					ctx({ expanded: true, isError }),
				),
			);
			expect(text).toContain("Child answer");
			expect(text).toContain("Host follow-up");
			expect(text).not.toContain("untrusted-");
		},
	);

	it("names the goal in the call row, without the profile", () => {
		expect(
			rendered(
				renderAgentCall(
					{ task: "t", goal: "audit auth token refresh", profile: "reviewer", isolate: true },
					theme,
					ctx(),
				),
			),
		).toContain("Agent(audit auth token refresh · isolated)");
	});

	it("summarizes a finished run briefly: outcome, tool calls and elapsed time, no zero count", () => {
		expect(doneSummary(details(), 38_000)).toBe("Done · 2 tool calls · 38s");
		expect(doneSummary(details({ toolCalls: 1 }), undefined)).toBe("Done · 1 tool call");
		expect(doneSummary(details({ toolCalls: 0 }), 4_000)).toBe("Done · 4s");
		expect(doneSummary(details(), 38_000, true)).toBe("Done · general-0001 · 2 tool calls · 38s");
	});

	it("moves tokens, cost and the model (without its provider) to the expanded summary", () => {
		const run = (expanded: boolean) =>
			rendered(
				renderAgentResult(
					{
						content: [{ type: "text", text: "answer" }],
						details: details({ cacheRead: 1_200, cost: 0.12, model: "anthropic/claude-haiku-5-5:low" }),
					},
					{ isPartial: false, expanded },
					theme,
					ctx({ expanded, durationMs: 38_000 }),
				),
			);
		expect(run(false)).toContain("⎿  Done · general-0001 · 2 tool calls · 38s\n");
		expect(run(false)).not.toContain("↑");
		expect(run(false)).not.toContain("claude-haiku-5-5");
		expect(run(true)).toContain(
			"Done · general-0001 · 2 tool calls · 38s · ↑300 +1.2k cached ↓500 · ≈$0.12 · claude-haiku-5-5:low",
		);
		expect(run(true)).not.toContain("anthropic/");
	});

	it("labels a run by the outcome its report names, Done when it names none", () => {
		expect(doneSummary(details({ outcome: "done" }), 38_000)).toBe("Done · 2 tool calls · 38s");
		expect(doneSummary(details({ outcome: "partial" }), 38_000)).toBe("Partial · 2 tool calls · 38s");
		expect(doneSummary(details({ outcome: "blocked" }), undefined)).toMatch(/^Blocked · /);
		expect(
			rendered(
				renderAgentResult(
					{
						content: [{ type: "text", text: "blocked: need a decision" }],
						details: details({ outcome: "blocked" }),
					},
					{ isPartial: false, expanded: false },
					theme,
					ctx(),
				),
			),
		).toContain("⎿  Blocked · general-0001");
	});

	it("draws the call with its goal and tags, never the prompt or the profile", () => {
		const call = rendered(
			renderAgentCall({ task: "look\nsecond", profile: "researcher", background: true }, theme, ctx()),
		);
		expect(call).toMatch(/^. Agent · background/);
		expect(call).not.toContain("look");
		expect(call).not.toContain("researcher");
		expect(
			rendered(
				renderAgentCall({ task: "x", profile: "implementer", model: "openai/gpt-5", isolate: true }, theme, ctx()),
			),
		).toContain("Agent(openai/gpt-5 · isolated)");
		expect(rendered(renderAgentCall({ background: true }, theme, ctx()))).toMatch(/^. Agent · background/);
	});

	it("draws a background start, Octocode's native duration and a run without details", () => {
		const background = rendered(
			renderAgentResult(
				{ content: [{ type: "text", text: "started" }], details: details({ status: "background" }) },
				{ isPartial: false, expanded: false },
				theme,
				ctx(),
			),
		);
		expect(background).toContain("Running in the background as general-0001");
		expect(background).not.toContain("started");
		// Only model-directed text behind it: no expand hint. A later note (an isolation warning) can be expanded to.
		expect(background).not.toContain("to expand");
		const warned = (expanded: boolean) =>
			rendered(
				renderAgentResult(
					{
						content: [{ type: "text", text: "Started general-0001 in the background.\n\nNot isolated: no git repo" }],
						details: details({ status: "background" }),
					},
					{ isPartial: false, expanded },
					theme,
					ctx({ expanded }),
				),
			);
		expect(warned(false)).toContain("to expand");
		expect(warned(true)).toContain("Not isolated: no git repo");
		expect(warned(true)).not.toContain("Started general-0001");
		const finished = rendered(
			renderAgentResult(
				{ content: [{ type: "text", text: "answer" }], details: details() },
				{ isPartial: false, expanded: false },
				theme,
				ctx({ durationMs: 90_000 }),
			),
		);
		expect(finished).toContain("Done · general-0001 · 2 tool calls · 1m30s");
		const bare = rendered(
			renderAgentResult(
				{ content: [{ type: "text", text: "Subagent failed\ndetail" }], details: undefined },
				{ isPartial: false, expanded: false },
				theme,
				ctx({ isError: true }),
			),
		);
		expect(bare).toContain("Subagent failed");
	});

	it("shows the full prompt above the report only when expanded", () => {
		const args = { task: "Find the bug\n\x1b]0;evil\x07in auth.ts", profile: "researcher" };
		const run = (expanded: boolean) =>
			rendered(
				renderAgentResult(
					{ content: [{ type: "text", text: "The answer" }], details: details() },
					{ isPartial: false, expanded },
					theme,
					ctx({ args, expanded }),
				),
			);
		expect(run(false)).not.toContain("Find the bug");
		expect(run(false)).toContain("The answer");
		expect(run(false)).toContain("to expand");
		const open = run(true);
		expect(open).toMatch(/Prompt\n\s+Find the bug\n\s+in auth\.ts\n\s*\n\s+Report\n\s+The answer/);
		expect(open).not.toContain("\x1b]0;");
		const live = (expanded: boolean) =>
			rendered(
				renderAgentResult(
					{ content: [], details: details({ status: "running" }) },
					{ isPartial: true, expanded },
					theme,
					ctx({ args, expanded, isPartial: true, executionStarted: true }),
				),
			);
		expect(live(false)).toContain("general-0001 · 2 tool calls");
		expect(live(true)).toMatch(/Prompt[\s\S]*Progress[\s\S]*→ read a\.ts/);
		const thinking = rendered(
			renderAgentResult(
				{ content: [], details: details({ status: "running", thinking: "Check the lock" }) },
				{ isPartial: true, expanded: false },
				theme,
				ctx({ args, isPartial: true, executionStarted: true }),
			),
		);
		expect(thinking).toContain("✻ Check the lock…");
		// A stop in progress says so until the run has closed.
		const stopping = rendered(
			renderAgentResult(
				{ content: [], details: details({ status: "running", stopping: true }) },
				{ isPartial: true, expanded: false },
				theme,
				ctx({ args, isPartial: true, executionStarted: true }),
			),
		);
		expect(stopping).toContain("stopping… (general-0001 · 2 tool calls");
		// A child with a dialog open for the user's answer says so.
		const waiting = rendered(
			renderAgentResult(
				{ content: [], details: details({ status: "running", waiting: true }) },
				{ isPartial: true, expanded: false },
				theme,
				ctx({ args, isPartial: true, executionStarted: true }),
			),
		);
		expect(waiting).toContain("waiting for your approval (general-0001 · 2 tool calls");
	});

	it("shows a background report with its name and goal (not its role), and its full prompt when expanded", () => {
		const message = (expanded: boolean) =>
			rendered(
				renderAgentMessage(
					{
						role: "custom",
						customType: "x",
						content: "Background subagent general-0001 finished (3s · 1 tool call):\nAll fixed.",
						details: {
							id: "general-0001",
							status: "done",
							summary: "Done (1 tool call)",
							durationMs: 3_000,
							profile: "researcher",
							goal: "fix login flow",
							task: "Fix login\nin src/auth.ts",
						},
						display: true,
						timestamp: 0,
					} as never,
					{ expanded, outputPad: 1 },
					theme,
				) as never,
			);
		expect(message(false)).toContain("Agent(general-0001 · fix login flow)");
		expect(message(false)).not.toContain("researcher");
		expect(message(false)).not.toContain("Fix login");
		expect(message(false)).toContain("All fixed.");
		expect(message(true)).toMatch(/Prompt\n\s+Fix login\n\s+in src\/auth\.ts\n\s*\n\s+Report\n\s+All fixed\./);
	});

	it("draws a background report message without details as a plain report", () => {
		const box = renderAgentMessage(
			{ role: "custom", customType: "x", content: "Report head\nbody", display: true, timestamp: 0 } as never,
			{ expanded: true, outputPad: 1 },
			theme,
		);
		const text = rendered(box as never);
		expect(text).toContain("Agent(background)");
		expect(text).toContain("Report head");
		expect(text).toContain("body");
		const failed = rendered(
			renderAgentMessage(
				{
					role: "custom",
					customType: "x",
					content: "x",
					display: true,
					timestamp: 0,
					details: { id: "a-1", status: "failed", summary: "Failed: boom", durationMs: 1_200 },
				} as never,
				{ expanded: false, outputPad: 2 },
				theme,
			) as never,
		);
		expect(failed).toMatch(/Agent\(a-1\).*1\.2s/);
		expect(failed).toContain("Failed: boom");
		expect(failed).not.toContain("Error: Failed");
	});

	it("draws any stop as an interruption (◼ warning), never as a failure", () => {
		const colored = { ...(theme as object), fg: (color: string, text: string) => `<${color}>${text}` };
		const stopped = (requested: boolean) =>
			rendered(
				renderAgentMessage(
					{
						role: "custom",
						customType: "x",
						content: "x",
						display: true,
						timestamp: 0,
						details: { id: "a-1", status: "stopped", summary: "Stopped", requested },
					} as never,
					{ expanded: false, outputPad: 2 },
					colored as never,
				) as never,
			);
		for (const requested of [true, false]) {
			expect(stopped(requested)).toContain("<warning>◼");
			expect(stopped(requested)).not.toContain("<error>");
		}
	});
});
