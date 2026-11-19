import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { Type } from "typebox";
import { renderPrompt } from "../../core/prompt-template.ts";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { textResult } from "../shared/util.ts";
import { checkGoal, GOAL_DESCRIPTION } from "../team/identity.ts";
import type { RunPlan } from "./claim.ts";
import { runRunnerChild } from "./runner-child.ts";
import type { Runners } from "./runner-port.ts";
import type { Team } from "../team/session.ts";

/** Task fields that belong to an Octocode child: a runner has its own tools, skills and session, so they do not apply. */
const NATIVE_ONLY = ["skills", "mcp", "profile", "resume", "headless"] as const;

/** The `runner` field of a task, declared when an installed runnable CLI is available in this session. */
export const runnerField = (ids: readonly string[]) =>
	Type.Optional(
		StringEnum(ids, {
			description:
				"Installed vendor CLI with its own model/sign-in (checked when used; plan or metered key). No skills, mcp, profile, resume or headless.",
		}),
	);

/**
 * The plan of a runner task: no profile, and the runner as its route (`claude-code/opus`), so the start result and the
 * row say where it runs. Refuses a runner unavailable in this session and the fields only an Octocode child takes.
 */
export function runnerPlan(params: Record<string, unknown>, runners: Runners | undefined): RunPlan {
	const runner = String(params.runner);
	if (!runners?.ids.includes(runner))
		throw new Error(
			`Runner ${runner} is unavailable in this session${runners?.ids.length ? `; available: ${runners.ids.join(", ")}` : ""}. Check /providers (External agents), then start a new session to discover installed runners.`,
		);
	const native = NATIVE_ONLY.filter((field) => params[field] !== undefined);
	if (native.length) throw new Error(`A runner task does not take ${native.join(", ")}.`);
	const model = typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined;
	return { profile: undefined, route: { model: model ? `${runner}/${model}` : runner, via: `runner ${runner}` } };
}

/** The part of the session's permission state a child's runner task asks: the spawn class, relayed to its parent. */
interface SpawnPermission {
	check(
		ctx: FeatureContext,
		request: { action: "agent.spawn"; title: string; what: string[]; purpose: string; signal: AbortSignal },
	): Promise<{ allowed: boolean }>;
}

/**
 * A subagent's `agent` task type when a runner is available: it starts only runner tasks, in the foreground, in its own
 * working directory (its worktree when it is isolated). The runner's process belongs to this child, whose process tree
 * its parent stops; the spawn approval and the runner's permission requests reach the user through the parent's relay.
 */
export function registerChildRunnerTask(
	runners: Runners,
	permission: SpawnPermission,
	registerTool: FeatureSetup["tools"]["register"],
	team?: Team,
): void {
	let started = 0;
	registerTool({
		name: "agent",
		roleVariant: true,
		label: "Agent",
		description:
			"Run a self-contained task in an installed vendor CLI using its own sign-in, checked when used, and return its report; the call waits for it.",
		parameters: Type.Object({
			runner: StringEnum(runners.ids, { description: renderPrompt("tools/agent/child-runner.md") }),
			goal: Type.String({ description: GOAL_DESCRIPTION }),
			task: Type.String({ description: "The whole brief: the runner sees nothing else of this session" }),
			model: Type.Optional(Type.String({ description: "The runner's own model option" })),
		}),
		async execute(id, params, signal, _onUpdate, ctx) {
			const goal = checkGoal(params.goal);
			const runner = params.runner;
			const verdict = await permission.check(ctx, {
				action: "agent.spawn",
				title: `Start ${runner} on this task?`,
				what: [goal, params.task],
				purpose: `${runner} runs it with its own tools, permissions and sign-in.`,
				signal: signal ?? new AbortController().signal,
			});
			if (!verdict.allowed) throw new Error(`Starting ${runner} was not allowed.`);
			started += 1;
			const outcome = await runRunnerChild(runners, {
				runner,
				...(params.model ? { model: params.model } : {}),
				task: params.task,
				cwd: ctx.cwd,
				identity: { id: `${runner}-${started}-${id.slice(-6)}`, goal },
				signal,
				onProgress: () => undefined,
				ctx,
				team,
			});
			return textResult(outcome.text, {
				runner,
				goal,
				billing: outcome.billing,
				usage: outcome.usage,
				...(outcome.outcome ? { outcome: outcome.outcome } : {}),
			});
		},
	});
}
