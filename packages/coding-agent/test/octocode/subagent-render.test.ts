import { describe, expect, it } from "vitest";
import {
	doneSummary,
	renderAgentCall,
	renderAgentMessage,
	renderAgentResult,
} from "../../src/octocode/subagents/render.ts";
import { rendered, theme } from "./fake-host.ts";
import type { RunDetails } from "../../src/octocode/subagents/run-types.ts";
import { fenceUntrusted } from "../../src/octocode/shared/fence.ts";
import { stripTerminalSequences } from "@octocodeai/octocode-tui";

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

	it("summarizes a finished run briefly: outcome and tool calls, no zero count; the header carries the time", () => {
		expect(doneSummary(details())).toBe("Done · 2 tool calls");
		expect(doneSummary(details({ toolCalls: 1 }))).toBe("Done · 1 tool call");
		expect(doneSummary(details({ toolCalls: 0 }))).toBe("Done");
		expect(doneSummary(details(), true)).toBe("Done · general-0001 · 2 tool calls");
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
		expect(run(false)).toContain("⎿  Done · general-0001 · 2 tool calls\n");
		expect(run(false)).not.toContain("38s");
		expect(run(false)).not.toContain("↑");
		expect(run(false)).not.toContain("claude-haiku-5-5");
		expect(run(true)).toContain(
			"Done · general-0001 · 2 tool calls · ↑300 +1.2k cached ↓500 · ≈$0.12 · claude-haiku-5-5:low",
		);
		expect(run(true)).not.toContain("anthropic/");
	});

	it("labels a run by the outcome its report names, Done when it names none", () => {
		expect(doneSummary(details({ outcome: "done" }))).toBe("Done · 2 tool calls");
		expect(doneSummary(details({ outcome: "partial" }))).toBe("Partial · 2 tool calls");
		expect(doneSummary(details({ outcome: "blocked" }))).toMatch(/^Blocked · /);
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
		// The duration shows once, in the header; the outcome does not repeat it.
		expect(finished).toContain("⎿  Done · general-0001 · 2 tool calls\n");
		expect(finished).not.toContain("1m30s");
		expect(rendered(renderAgentCall({ task: "x" }, theme, ctx({ durationMs: 90_000 })))).toBe("✓ Agent · 1m30s");
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

	it("draws any stop as a red light with the warning-toned summary", () => {
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
			// A stopped agent's light is red like a failed one; its words stay in the warning tone.
			expect(stopped(requested)).toContain("<error>◼");
			expect(stopped(requested)).toContain("<warning>Stopped");
		}
	});
});

describe("the call row names the model and level the child runs on", () => {
	// One row: the call and its result share `state`, as the host passes them.
	const row = (resultDetails: RunDetails, args: Record<string, unknown> = { goal: "audit auth" }) => {
		const shared = ctx({ args, state: {}, invalidate: () => undefined });
		renderAgentResult(
			{ content: [], details: resultDetails },
			{ isPartial: resultDetails.status === "running", expanded: false },
			theme,
			ctx({ args, state: (shared as { state: unknown }).state, isPartial: resultDetails.status === "running" }),
		);
		return rendered(renderAgentCall(args, theme, shared));
	};

	it("shows the resolved model without its provider, with the level the profile or default gave it", () => {
		const running = details({ status: "running", model: "anthropic/claude-haiku-5-5:low" });
		expect(row(running)).toContain("Agent(audit auth · claude-haiku-5-5:low)");
		// A purpose or bare id in the call is replaced by what it resolved to.
		expect(row(running, { goal: "audit auth", model: "small" })).toContain("Agent(audit auth · claude-haiku-5-5:low)");
		expect(row(running, { goal: "audit auth", model: "small" })).not.toContain("small");
	});

	describe("a finished run's outcome row", () => {
		const outcome = (width: number, extra: Partial<RunDetails> = {}, expanded = false) =>
			stripTerminalSequences(
				renderAgentResult(
					{ content: [], details: details({ toolCalls: 14, ...extra }) },
					{ isPartial: false, expanded },
					theme,
					ctx({ expanded }),
				).render(width)[0] ?? "",
			).trimEnd();

		it.each([
			[120, "  ⎿  Done · general-0001 · 14 tool calls · 2 denied"],
			[80, "  ⎿  Done · general-0001 · 14 tool calls · 2 denied"],
			[40, "  ⎿  Done · general-0001 · 14 tool calls"],
			[30, "  ⎿  Done · general-0001"],
			[20, "  ⎿  Done"],
		])("drops trailing parts whole, never cutting one, at %i columns", (width, row) => {
			expect(outcome(width, { denied: 2 })).toBe(row);
		});

		it("keeps the outcome itself, cut with …, only when even it does not fit", () => {
			expect(outcome(8, { outcome: "blocked" })).toBe("  ⎿  Bl…");
		});

		it("drops the expanded stats whole from the end too", () => {
			const wide = outcome(200, { model: "anthropic/claude-haiku-5-5" }, true);
			const parts = wide.split(" · ");
			expect(parts.slice(0, 3)).toEqual(["  ⎿  Done", "general-0001", "14 tool calls"]);
			for (let kept = parts.length; kept >= 1; kept--) {
				const row = parts.slice(0, kept).join(" · ");
				expect(outcome(row.length, { model: "anthropic/claude-haiku-5-5" }, true)).toBe(row);
			}
		});
	});

	it("keeps the requested model until the run reports its route", () => {
		expect(rendered(renderAgentCall({ goal: "g", model: "openai/gpt-5" }, theme, ctx()))).toContain(
			"Agent(g · openai/gpt-5)",
		);
		expect(row(details({ status: "running" }), { goal: "g", model: "openai/gpt-5" })).toContain(
			"Agent(g · openai/gpt-5)",
		);
	});
});
