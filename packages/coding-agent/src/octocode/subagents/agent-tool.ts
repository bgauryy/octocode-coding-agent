import { Type } from "typebox";
import { reasonSchema } from "../shared/reason.ts";
import { GOAL_DESCRIPTION } from "../team/identity.ts";
import { maxSubagents } from "./claim.ts";

/**
 * The `agent` tool's declaration: its name, label, description and parameters. Built at registration, so the description
 * names the subagent limit in force for that session.
 */
export function agentToolSpec() {
	return {
		name: "agent",
		label: "Agent",
		description:
			"Delegate a self-contained task to a fresh session without this conversation. " +
			`Foreground returns its report; background returns its id and delivers the report later. At most ${maxSubagents()} at once; more wait.`,
		parameters: Type.Object({
			skills: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Skills the child needs: one named only in the task text is rarely loaded. Omit for profile skills or the loaded catalog; [] for none.",
				}),
			),
			mcp: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"MCP servers the child gets: these configured servers plus any its profile names; other servers stay out. Omit for the profile's servers and the session's; [] for the profile's own only. An unknown or disabled name refuses the task.",
				}),
			),
			goal: Type.String({ description: GOAL_DESCRIPTION }),
			task: Type.String({
				description:
					"The brief `<delegation>` describes. Cited msg#<N> messages and report:<agent-id> excerpts are appended, fenced; invalid or oversized references refuse the call.",
			}),
			item: Type.Optional(
				Type.String({
					description: "Backlog item you hold (ongoing); the child may update only it, and its report is noted there.",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"Finished or stopped child id from this session: continues its saved conversation, with its profile, on this task; with model, on that route. An isolated child cannot resume: start a new one with recovery context.",
				}),
			),
			profile: Type.Optional(
				Type.String({
					description: "Profile name; omit for general-purpose",
				}),
			),
			headless: Type.Optional(
				Type.Boolean({
					description: "Browser: true headless (default); false visible with persistent logins",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model and thinking for this task: provider/id, bare id, small or medium, optional :off|minimal|low|medium|high|xhigh|max. Default: the profile's (see models); no profile: medium; thinking medium.",
				}),
			),
			resultSchema: Type.Optional(
				// A plain object schema: `Type.Record` would add a `patternProperties` block to every request for the same meaning.
				Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description:
						"JSON Schema for the child's final JSON result (verdict in details). Supported keywords: type, properties, required, additionalProperties, items, enum, const, description, numeric/length bounds.",
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
						"Private worktree; changes export to refs/octocode/<id>, linked on `item`. Land them with `coordinate` action `merge`, not git merge.",
				}),
			),
			workingCopy: Type.Optional(
				Type.Boolean({
					description:
						"With isolate: start from a snapshot of tracked and non-ignored untracked files; conflicts keep the worktree.",
				}),
			),
			paths: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Files, or "dir/" for a tree, the child will edit: reserved for it from start to report, so you need no lock or unlock. A path held by another child of this session queues the start until it reports; any other holder refuses it. No effect with isolate or a read-only profile.',
				}),
			),
			// The `agent` call's own reason (`octocode/agent-tool.ts` passes it to a type that declares one): the child's why.
			reason: Type.Optional(reasonSchema()),
		}),
	};
}
