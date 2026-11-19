import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { HOOK_MODES } from "../../../shared/hook-mode.ts";
import { CACHE_CHOICES } from "../../../subagents/process/env.ts";
import { reasonSchema } from "../../../shared/reason.ts";
import { GOAL_DESCRIPTION } from "../../../team/identity.ts";
import { maxSubagents } from "../../../subagents/claim.ts";
import { runnerField } from "../../../subagents/runner-task.ts";

/**
 * The `agent` tool's declaration: its name, label, description and parameters. Built at registration, so the description
 * names the subagent limit in force for that session, and `runner` is declared only when `runners` names an installed runnable CLI.
 */
export function agentToolSpec(runners: readonly string[] = []) {
	const spec = {
		name: "agent",
		roleVariant: true,
		label: "Agent",
		description:
			"Delegate a self-contained task to a fresh session without this conversation. " +
			`Foreground returns its report; background returns its id and delivers the report later. At most ${maxSubagents()} at once; more wait.`,
		parameters: Type.Object({
			skills: Type.Optional(
				Type.Array(Type.String(), {
					description: "Skills to load; omit: profile default; []: none",
				}),
			),
			mcp: Type.Optional(
				Type.Array(Type.String(), {
					description: "MCP servers added to profile defaults; omit: session servers; []: profile only",
				}),
			),
			goal: Type.Optional(
				Type.String({
					description: `${GOAL_DESCRIPTION}; required when new`,
				}),
			),
			task: Type.String({
				description:
					"Required, also on resume; brief per the octocode-subagents skill. msg#<N> or report:<agent-id> appends that message or report.",
			}),
			item: Type.Optional(
				Type.String({
					description: "Your ongoing item or an unclaimed one (claimed here); the child updates only it.",
				}),
			),
			after: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"With background: start once each B<n> is done and each agent:<name> reports done; a failure holds it.",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"Continue this session's finished or stopped child (needs task); a queued or held child starts now.",
				}),
			),
			profile: Type.Optional(
				Type.String({
					description: "Profile; omit: general-purpose",
				}),
			),
			headless: Type.Optional(
				Type.Boolean({
					description: "Browser: false shows the window; default headless",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"provider/id, bare id, small or medium; optional :off|minimal|low|medium|high|xhigh|max. Default: profile, else medium",
				}),
			),
			resultSchema: Type.Optional(
				// A plain object schema: `Type.Record` would add a `patternProperties` block to every request for the same meaning.
				Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description: "JSON Schema of the final verdict (details); every node needs type",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: "Return at once; the report comes later",
				}),
			),
			hooks: Type.Optional(StringEnum(HOOK_MODES, { description: "User hooks (default off)" })),
			cache: Type.Optional(StringEnum(CACHE_CHOICES, { description: "History cache tier" })),
			isolate: Type.Optional(
				Type.Boolean({
					description: "Private worktree; coordinate merge lands it",
				}),
			),
			workingCopy: Type.Optional(
				Type.Boolean({
					description: "With isolate: start from the working copy",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Files or "dir/" reserved until the report',
				}),
			),
			runner: runnerField(runners),
			// The `agent` call's own reason (`native/tools/agent/tool.ts` passes it to a type that declares one): the child's why.
			reason: Type.Optional(reasonSchema()),
		}),
	};
	// Typed always, declared only when an installed runner is available in this session.
	if (runners.length === 0) Reflect.deleteProperty(spec.parameters.properties, "runner");
	return spec;
}
