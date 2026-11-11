import { Type } from "typebox";
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
						"Skills the child needs (a skill named only in the task text is rarely loaded). Omit: the profile's or the loaded catalog; []: none.",
				}),
			),
			mcp: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"MCP servers the child gets, plus its profile's. Omit: the profile's and the session's; []: the profile's only. An unknown or disabled name refuses the task.",
				}),
			),
			goal: Type.Optional(
				Type.String({
					description: `${GOAL_DESCRIPTION}. Required for a new child; with resume, omit to keep its goal`,
				}),
			),
			task: Type.String({
				description:
					"The brief `<delegation>` describes. Cited msg#<N> messages and report:<agent-id> excerpts are appended, fenced; invalid or oversized references refuse the call.",
			}),
			item: Type.Optional(
				Type.String({
					description:
						"Backlog item you hold (ongoing), or an unheld todo/backlog one with goal and why, which the call claims: the child may update only it; its report is noted there.",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"Id of a finished or stopped child of this session: continues its conversation (with model, on that route). An isolated child cannot resume.",
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
						'Files or "dir/" the child will edit, reserved until it reports (no lock needed). A sibling child\'s path queues the start; any other holder refuses it. No effect with isolate or a read-only profile.',
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
