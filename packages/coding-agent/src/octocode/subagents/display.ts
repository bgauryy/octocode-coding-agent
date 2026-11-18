import type { ToolDisplay, ToolDisplayBlock } from "@octocodeai/octocode-contracts";
import type { ToolDisplayInput } from "../../core/features/types.ts";
import { displayText, pathBlock, textResultDisplay } from "../render/display.ts";
import { fencedParts } from "../shared/fence.ts";
import { withoutProvider } from "./model.ts";
import { doneSummary, finishedStats, runStats } from "./render.ts";
import { agentState, headerOverride } from "./render-state.ts";
import type { RunDetails } from "./run-types.ts";

interface AgentArgs {
	task?: string;
	goal?: string;
	model?: string;
	background?: boolean;
	isolate?: boolean;
}

/**
 * `Agent(goal · model · isolated) · background`, the prompt one expand away; while it runs its stats and latest steps,
 * then its outcome, stats and Markdown report.
 */
export function agentTaskDisplay(input: ToolDisplayInput<AgentArgs, RunDetails | undefined>): ToolDisplay {
	const { args, result, status } = input;
	const details = result?.details;
	const model = withoutProvider(details?.model) ?? args.model;
	const summary = [
		args.goal,
		model,
		args.isolate ? (details?.id ? `isolated · worktree ${details.id}` : "isolated") : "",
	]
		.filter(Boolean)
		.join(" · ");
	const head: ToolDisplay = {
		title: "Agent",
		...(summary ? { summary } : {}),
		...(args.background ? { meta: ["background"] } : {}),
		kind: "agent",
		...(args.task ? { preface: [{ type: "markdown", text: args.task }] } : {}),
		blocks: [],
	};
	if (!result) return head;
	const raw = displayText(result);
	const fenced = fencedParts(raw);
	const body = fenced ? [fenced.body, fenced.footer].filter(Boolean).join("\n\n") : raw;
	if (status === "failed" || !details) return textResultDisplay(head, input);
	const state = headerOverride(agentState(details));
	const marked = state ? { ...head, state } : head;
	if (status === "running" && details.status === "waiting")
		return { ...marked, outcome: { text: body, tone: "muted" } };
	if (status === "running") {
		const steps: ToolDisplayBlock[] = [
			...details.activity.slice(-3).map((line) => ({ type: "text" as const, text: line, tone: "muted" as const })),
			...(details.thinking ? [{ type: "text" as const, text: `✻ ${details.thinking}…`, tone: "muted" as const }] : []),
			...pathBlock(details.shot, "screenshot"),
		];
		const what = details.stopping
			? "stopping… "
			: details.waiting
				? "waiting for your approval "
				: details.compacting
					? "compacting its context "
					: "";
		return {
			...marked,
			outcome: {
				text: what ? `${what}(${runStats(details)})` : runStats(details),
				...(details.stopping || details.waiting ? { tone: "warning" as const } : {}),
			},
			blocks: steps,
		};
	}
	if (details.status === "background") {
		const note = body.split("\n").slice(1).join("\n").trim();
		return {
			...marked,
			outcome: {
				text: `${details.queued ? "Queued in the background" : "Running in the background"} as ${details.id}`,
			},
			blocks: note ? [{ type: "text", text: note }] : [],
		};
	}
	const stats = finishedStats(details, details);
	return {
		...marked,
		outcome: { text: doneSummary(details, true), ...(state === "failed" ? { tone: "error" as const } : {}) },
		blocks: [
			...(body.trim() ? [{ type: "markdown" as const, text: body }] : []),
			...(stats ? [{ type: "text" as const, text: stats, tone: "muted" as const }] : []),
		],
	};
}
