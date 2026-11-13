import { StringEnum } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { HOOK_MODES } from "../shared/hook-mode.ts";
import { CACHE_CHOICES } from "./process/env.ts";
import { reasonSchema } from "../shared/reason.ts";
import { GOAL_DESCRIPTION } from "../team/identity.ts";
import { maxSubagents } from "./claim.ts";
import { runnerField } from "./runner-task.ts";

/**
 * The `agent` tool's declaration: its name, label, description and parameters. Built at registration, so the description
 * names the subagent limit in force for that session, and `runner` is declared only when `runners` names a connected one.
 */
export function agentToolSpec(runners: readonly string[] = []) {
	const spec = {
		name: "agent",
		label: "Agent",
		description:
			"Delegate a self-contained task to a fresh session without this conversation. " +
			`Foreground returns its report; background returns its id and delivers the report later. At most ${maxSubagents()} at once; more wait.`,
		parameters: Type.Object({
			skills: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Skills the child needs; task text alone rarely loads them. Omit: profile's or loaded catalog; []: none.",
				}),
			),
			mcp: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"MCP servers added to the profile's. Omit: profile's plus session's; []: profile's only. Unknown or disabled names refuse the task.",
				}),
			),
			goal: Type.Optional(
				Type.String({
					description: `${GOAL_DESCRIPTION}. Required for a new child; with resume, omit to keep its goal`,
				}),
			),
			task: Type.String({
				description:
					"Brief as in <delegation>. Cited msg#<N> messages and report:<agent-id> excerpts append fenced; invalid or oversized references refuse the call.",
			}),
			item: Type.Optional(
				Type.String({
					description:
						"Your ongoing backlog item, or unheld todo/backlog with goal and why (claimed here). Child may update only it; its report is noted there.",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"This session's finished/stopped child id; continues its conversation, on model if given. Isolated children cannot resume.",
				}),
			),
			profile: Type.Optional(
				Type.String({
					description: "Profile name; omit: general-purpose",
				}),
			),
			headless: Type.Optional(
				Type.Boolean({
					description: "Browser: true: headless (default); false: visible, with persistent logins",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"provider/id, bare id, small or medium, optional :off|minimal|low|medium|high|xhigh|max thinking. Default: the profile's (see models); no profile: medium, thinking medium.",
				}),
			),
			resultSchema: Type.Optional(
				// A plain object schema: `Type.Record` would add a `patternProperties` block to every request for the same meaning.
				Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description:
						"JSON Schema for the child's final JSON result (verdict in details). Supported: type, properties, required, additionalProperties, items, enum, const, description, numeric/length bounds.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: "Return at once for independent work.",
				}),
			),
			hooks: Type.Optional(StringEnum(HOOK_MODES, { description: "User hooks the child runs (default off)" })),
			cache: Type.Optional(StringEnum(CACHE_CHOICES, { description: "History cache tier (default: by task shape)" })),
			isolate: Type.Optional(
				Type.Boolean({
					description:
						"Private worktree; changes export to refs/octocode/<id>, linked on `item`; land with coordinate `merge`.",
				}),
			),
			workingCopy: Type.Optional(
				Type.Boolean({
					description:
						"With isolate: start from a snapshot of tracked and untracked non-ignored files; conflicts keep the worktree.",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Files or "dir/" reserved until child reports; no lock needed. Sibling-held paths queue the start; other holders refuse it. No effect with isolate or a read-only profile.',
				}),
			),
			runner: runnerField(runners),
			// The `agent` call's own reason (`octocode/agent-tool.ts` passes it to a type that declares one): the child's why.
			reason: Type.Optional(reasonSchema()),
		}),
	};
	// Typed always, declared only while a runner is connected: the default prompt carries no runner text.
	if (runners.length === 0) Reflect.deleteProperty(spec.parameters.properties, "runner");
	return spec;
}
