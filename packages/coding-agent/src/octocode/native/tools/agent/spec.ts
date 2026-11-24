import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { HOOK_MODES } from "../../../shared/hook-mode.ts";
import { CACHE_CHOICES } from "../../../subagents/process/env.ts";
import { reasonSchema } from "../../../shared/reason.ts";
import { GOAL_DESCRIPTION } from "../../../team/identity.ts";
import { maxRequests } from "../../../subagents/budget.ts";
import { maxSubagents } from "../../../subagents/claim.ts";
import { runnerField } from "../../../subagents/runner-task.ts";

/**
 * The `agent` tool's declaration: its name, label, description and parameters. Built at registration, so the description
 * names the subagent limit in force for that session, and `runner` is declared only when `runners` names an installed runnable CLI.
 */
export function agentToolSpec(runners: readonly string[] = [], desktop = false) {
	// The default the description names: a profile without its own `maxRequests` has it (`budget.ts`).
	const requests = maxRequests() || "off";
	const spec = {
		name: "agent",
		roleVariant: true,
		label: "Agent",
		description:
			"Delegate a self-contained task to a fresh session without this conversation. " +
			`Foreground returns its report; background its id, the report later. At most ${maxSubagents(process.env)} at once; more queue.`,
		parameters: Type.Object({
			skills: Type.Optional(
				Type.Array(Type.String(), {
					description: "Skills; omit: profile's; empty: none",
				}),
			),
			mcp: Type.Optional(
				Type.Array(Type.String(), {
					description: "MCP servers beyond the profile's",
				}),
			),
			goal: Type.Optional(
				Type.String({
					description: `${GOAL_DESCRIPTION}; required when new, unless item names one (its title)`,
				}),
			),
			task: Type.String({
				description: "Brief: goal, proof of done, files, facts it cannot find. Required, also on resume",
			}),
			item: Type.Optional(
				Type.String({
					description: "Item the child updates; claimed here if unclaimed",
				}),
			),
			after: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"With background: start after each B<n>, agent:<name>, job:bash-<n> ends and lock:full-run is free",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description: "Continue a finished or stopped child",
				}),
			),
			profile: Type.Optional(
				Type.String({
					description: "Profile; omit: general-purpose",
				}),
			),
			headless: Type.Optional(
				Type.Boolean({
					description: "Browser: false shows the window",
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
						"provider/id, id, small|medium|large; optional :off|minimal|low|medium|high|xhigh|max. Default: profile, else medium",
				}),
			),
			// Checked against the profile's limit when the task is planned (`taskRequestLimit`); a resume keeps it.
			maxRequests: Type.Optional(
				Type.Integer({
					description: `Soft request limit, at most the profile's (default ${requests}); stops at 1.5×`,
				}),
			),
			resultSchema: Type.Optional(
				// A plain object schema: `Type.Record` would add a `patternProperties` block to every request for the same meaning.
				Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description: "JSON Schema of the verdict; every node needs type",
				}),
			),
			// The description says what it returns: "background its id".
			background: Type.Optional(Type.Boolean()),
			hooks: Type.Optional(StringEnum(HOOK_MODES, { description: "User hooks (default off)" })),
			cache: Type.Optional(StringEnum(CACHE_CHOICES, { description: "History cache tier" })),
			context: Type.Optional(
				StringEnum(["fork"], {
					description: "fork: copies your chat (costly)",
				}),
			),
			isolate: Type.Optional(
				Type.Boolean({
					description: "Private worktree; land via coordinate merge",
				}),
			),
			workingCopy: Type.Optional(
				Type.Boolean({
					description: "With isolate: copy the working tree",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description: "Reserved till the report",
				}),
			),
			runner: runnerField(runners),
			// The `agent` call's own reason (`native/tools/agent/tool.ts` passes it to a type that declares one): the child's why.
			reason: Type.Optional(reasonSchema()),
		}),
	};
	// Typed always, declared only when an installed runner is available in this session.
	if (runners.length === 0) Reflect.deleteProperty(spec.parameters.properties, "runner");
	// Likewise `apps`: it only means something when the desktop specialist exists, so a session without Cua Driver does not carry it.
	if (!desktop) Reflect.deleteProperty(spec.parameters.properties, "apps");
	return spec;
}
