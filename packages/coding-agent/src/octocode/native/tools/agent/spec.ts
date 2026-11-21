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
			`Foreground returns its report; background returns its id, the report comes later. At most ${maxSubagents()} at once; more wait.`,
		parameters: Type.Object({
			skills: Type.Optional(
				Type.Array(Type.String(), {
					description: "Skills to load; omit: profile default; empty: none",
				}),
			),
			mcp: Type.Optional(
				Type.Array(Type.String(), {
					description: "MCP servers added to the profile defaults; omit: session's servers; empty: profile only",
				}),
			),
			goal: Type.Optional(
				Type.String({
					description: `${GOAL_DESCRIPTION}; required when new`,
				}),
			),
			task: Type.String({
				description:
					"Required, also on resume; brief per the octocode-subagents skill. msg#<N> or report:<agent-id> appends it.",
			}),
			item: Type.Optional(
				Type.String({
					description: "An ongoing or unclaimed item (claimed here); the child updates only it.",
				}),
			),
			after: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"With background: start after each B<n>, agent:<name>, job:bash-<n> finishes and lock:full-run is free; a failure holds it.",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description: "Continue a finished or stopped child of this session (needs task); a queued one starts now.",
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
			apps: Type.Optional(
				Type.Array(Type.String(), {
					description: "Desktop: the only apps it may control",
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
					description: "JSON Schema of the final verdict; every node needs type",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: "Return at once; report later",
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
					description: "With isolate: start from the working tree",
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
