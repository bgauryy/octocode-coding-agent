import { StringEnum } from "@octocodeai/octocode-contracts/schema";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { textResult } from "../shared/util.ts";
import { checkGoal, GOAL_DESCRIPTION } from "../team/identity.ts";
import type { RunPlan } from "./claim.ts";
import { runRunnerChild } from "./runner-child.ts";
import type { Runners } from "./runner-port.ts";

/** Task fields that belong to an Octocode child: a runner has its own tools, skills and session, so they do not apply. */
const NATIVE_ONLY = ["skills", "mcp", "profile", "resume", "headless"] as const;

/** The `runner` field of a task, declared only while a runner is connected (the default prompt carries none of it). */
export const runnerField = (ids: readonly string[]) =>
	Type.Optional(
		StringEnum(ids, {
			description:
				"Vendor CLI over ACP, using its own sign-in (plan or metered key; models). Worktree, report and stop behave as for children; model is its own option. No skills, mcp, profile, resume or headless.",
		}),
	);

/**
 * The plan of a runner task: no profile, and the runner as its route (`claude-code/opus`), so the start result and the
 * row say where it runs. Refuses a runner that is not connected and the fields only an Octocode child takes.
 */
export function runnerPlan(params: Record<string, unknown>, runners: Runners | undefined): RunPlan {
	const runner = String(params.runner);
	if (!runners?.ids.includes(runner))
		throw new Error(
			`Runner ${runner} is not connected${runners?.ids.length ? `; connected: ${runners.ids.join(", ")}` : ""}. Connect it in /providers (External agents).`,
		);
	const native = NATIVE_ONLY.filter((field) => params[field] !== undefined);
	if (native.length) throw new Error(`A runner task does not take ${native.join(", ")}.`);
	const model = typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined;
	return { profile: undefined, route: { model: model ? `${runner}/${model}` : runner, via: `runner ${runner}` } };
}

/** The part of the session's permission state a child's runner task asks: the spawn class, relayed to its parent. */
interface SpawnPermission {
	check(
		ctx: ExtensionContext,
		request: { action: "agent.spawn"; title: string; what: string[]; purpose: string; signal: AbortSignal },
	): Promise<{ allowed: boolean }>;
}

/**
 * A subagent's `agent` task type when a runner is connected: it starts only runner tasks, in the foreground, in its own
 * working directory (its worktree when it is isolated). The runner's process belongs to this child, whose process tree
 * its parent stops; the spawn approval and the runner's permission requests reach the user through the parent's relay.
 */
export function registerChildRunnerTask(
	runners: Runners,
	permission: SpawnPermission,
	registerTool: ExtensionAPI["registerTool"],
): void {
	let started = 0;
	registerTool({
		name: "agent",
		label: "Agent",
		description:
			"Run a self-contained task in a connected vendor CLI using its own sign-in and return its report; the call waits for it.",
		parameters: Type.Object({
			runner: StringEnum(runners.ids, { description: "The connected vendor CLI that does the task (see models)" }),
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
