import { type Component, Container, type TUI } from "@octocodeai/octocode-tui";
import type { ToolDefinition } from "../../src/core/features/types.ts";
import { BashExecutionComponent } from "../../src/modes/interactive/components/bash-execution.ts";
import { CompactionSummaryMessageComponent } from "../../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomMessageComponent } from "../../src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../../src/modes/interactive/components/skill-invocation-message.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { withBuiltInRenderers } from "../../src/octocode/files/built-in-renderers.ts";
import { renderFileCall, renderFileResult } from "../../src/octocode/files/render.ts";
import { renderAgentCall, renderAgentResult } from "../../src/octocode/subagents/render.ts";

const CWD = "/synthetic/project";
const OPTIONS = { showImages: false, outputPad: 1 };

/** A finished tool row drawn by the production component and the given renderers. */
function toolRow(
	ui: TUI,
	name: string,
	args: Record<string, unknown>,
	definition: Partial<ToolDefinition> | undefined,
	result: { content: Array<{ type: "text"; text: string }>; details?: unknown; isError?: boolean },
): ToolExecutionComponent {
	const row = new ToolExecutionComponent(name, `qa-${name}`, args, OPTIONS, definition as never, ui, CWD);
	row.setArgsComplete();
	row.markExecutionStarted();
	row.updateResult({ isError: false, ...result }, false);
	return row;
}

/** Tool rows: the core shell row, a one-file edit, a subagent and a renderer that threw. */
function toolRows(ui: TUI): Component[] {
	const bash = toolRow(ui, "bash", { command: "ls packages" }, withBuiltInRenderers("bash", undefined), {
		content: [{ type: "text", text: "[exit 0 · 0.1s · 3 lines · 14 B]\nagent\nai\ntui" }],
	});
	const diff = "-const text = clip(summary, 120);\n+const text = clip(summary, 160);";
	const file = toolRow(
		ui,
		"file",
		{ queries: [{ type: "edit", path: "src/render/tool.ts", edits: [{ oldText: "120", newText: "160" }] }] },
		{ renderCall: renderFileCall, renderResult: renderFileResult } as never,
		{
			content: [{ type: "text", text: "1. edit src/render/tool.ts" }],
			details: { outcomes: [{ type: "edit", path: "src/render/tool.ts", reason: "", ok: true, message: "ok", diff }] },
		},
	);
	const details = {
		id: "general-0001",
		profile: "general",
		goal: "audit transcript rows",
		toolCalls: 14,
		activity: [],
		input: 1_500,
		cacheRead: 0,
		output: 500,
		cost: 0,
		unpriced: false,
		startedAt: 0,
		status: "done",
	};
	const agent = toolRow(
		ui,
		"agent",
		{ goal: "audit transcript rows" },
		{ renderCall: renderAgentCall, renderResult: renderAgentResult } as never,
		{ content: [{ type: "text", text: "Rows follow one grammar." }], details },
	);
	const failed = toolRow(
		ui,
		"weird",
		{ a: 1 },
		{
			renderCall: () => {
				throw new Error("boom");
			},
		} as never,
		{ content: [{ type: "text", text: "ok" }] },
	);
	return [bash, file, agent, failed];
}

/** Message blocks: a user `!` command, a compaction, a skill load and a feature message without a renderer. */
function messageRows(ui: TUI): Component[] {
	const shell = new BashExecutionComponent("ls packages", ui);
	shell.appendOutput("agent\nai\ncoding-agent\ntui\n");
	shell.setComplete(0, false, undefined, undefined, "[exit 0 · 1.4s · 4 lines · 24 B]");
	const compaction = new CompactionSummaryMessageComponent({
		role: "compactionSummary",
		summary: "Rows follow one grammar.",
		tokensBefore: 123_456,
		timestamp: 0,
	});
	const skill = new SkillInvocationMessageComponent({
		name: "octocode-research",
		location: "/synthetic/skills/octocode-research/SKILL.md",
		content: "# Research\n\n1. Read the code.",
		userMessage: undefined,
	});
	const wake = new CustomMessageComponent({
		role: "custom",
		customType: "wake",
		content: "Timer fired: check the build log.",
		display: true,
		timestamp: 0,
	});
	return [shell, compaction, skill, wake];
}

/** The transcript rows of a QA state, each drawn by its production component. */
export function qaTranscript(ui: TUI, state: "transcript-tools" | "transcript-messages"): Container {
	const document = new Container();
	for (const row of state === "transcript-tools" ? toolRows(ui) : messageRows(ui)) document.addChild(row);
	return document;
}
