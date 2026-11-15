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
 * names the subagent limit in force for that session, and `runner` is declared only when `runners` names an installed runnable CLI.
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
					description: "Name needed skills explicitly. Omit: profile/catalog; []: none.",
				}),
			),
			mcp: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Add MCP servers to profile defaults. Omit: include session servers; []: profile only. Unknown/disabled names refuse.",
				}),
			),
			goal: Type.Optional(
				Type.String({
					description: `${GOAL_DESCRIPTION}. Required for a new child; with resume, omit to keep its goal`,
				}),
			),
			task: Type.String({
				description:
					"Brief as in <delegation>; msg#<N> appends the complete fenced message, report:<agent-id> a fenced report or bounded excerpt. Recognized references that cannot be resolved, including oversized messages, refuse the call.",
			}),
			item: Type.Optional(
				Type.String({
					description:
						"Your ongoing item, or unheld todo/backlog with goal+why (claimed here). Child updates only it; report noted there.",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"Continue this session's finished/stopped child, with optional model override. Isolated children cannot resume: start a task citing report:<id>.",
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
						"provider/id, unambiguous bare id, small or medium; optional :off|minimal|low|medium|high|xhigh|max. Default: profile; without one, medium with medium thinking.",
				}),
			),
			resultSchema: Type.Optional(
				// A plain object schema: `Type.Record` would add a `patternProperties` block to every request for the same meaning.
				Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description:
						"Final JSON Schema (verdict in details). Supports type/properties/required/additionalProperties/items/enum/const/description and numeric/length bounds.",
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
					description: "Private worktree; exports refs/octocode/<id>, linked on item; coordinate merge lands it.",
				}),
			),
			workingCopy: Type.Optional(
				Type.Boolean({
					description: "With isolate: snapshot tracked and untracked non-ignored files. Conflicts keep worktree.",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Reserve files or "dir/" until report; no lock needed. Sibling holders queue, others refuse. No effect with isolate/read-only profiles.',
				}),
			),
			runner: runnerField(runners),
			// The `agent` call's own reason (`octocode/agent-tool.ts` passes it to a type that declares one): the child's why.
			reason: Type.Optional(reasonSchema()),
		}),
	};
	// Typed always, declared only when an installed runner is available in this session.
	if (runners.length === 0) Reflect.deleteProperty(spec.parameters.properties, "runner");
	return spec;
}
