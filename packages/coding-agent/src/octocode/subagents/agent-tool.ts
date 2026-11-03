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
					description: "Skill names included in the task; omit for profile skills or the loaded catalog; [] for none.",
				}),
			),
			goal: Type.String({ description: GOAL_DESCRIPTION }),
			task: Type.String({
				description:
					"Task contract: objective, inputs (paths, evidence, decisions), constraints (scope, authorization, budget), output, Definition of Done. Cited msg#<N> messages and report:<agent-id> excerpts are appended, fenced; invalid or oversized references refuse the call.",
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
						"Model and thinking for this task: provider/id, bare id, small or medium, optional :off|minimal|low|medium|high|xhigh|max. Fit the task: small:low lookups and mechanical steps, medium scoped edits, medium:high review, your model :high root causes and design. Default: the profile's (see models); no profile: medium; thinking medium.",
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
			collaborate: Type.Optional(
				Type.Boolean({
					description:
						"Adds teammate context for shared work; does not enable messaging or grant authority. Name each task's owner.",
				}),
			),
			isolate: Type.Optional(
				Type.Boolean({
					description:
						"Private worktree; changes export to refs/octocode/<id>, linked on `item`. The user lands them with /agents merge <id>; slash commands are not yours to run.",
				}),
			),
			workingCopy: Type.Optional(
				Type.Boolean({
					description:
						"With isolate: start from a snapshot of tracked and non-ignored untracked files; conflicts keep the worktree.",
				}),
			),
			// The `agent` call's own reason (`octocode/agent-tool.ts` passes it to a type that declares one): the child's why.
			reason: Type.Optional(reasonSchema()),
		}),
	};
}
