import { Type } from "typebox";
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
			`Foreground returns its report; background returns its id and delivers the report later. At most ${maxSubagents()} at once; more wait. ` +
			"Never poll or sleep for reports.",
		parameters: Type.Object({
			skills: Type.Optional(
				Type.Array(Type.String(), {
					description: "Skill names included in the task; omit for profile skills or the loaded catalog; [] for none.",
				}),
			),
			goal: Type.String({ description: GOAL_DESCRIPTION }),
			task: Type.String({
				description:
					"Task contract: objective, required inputs (paths/evidence/decisions), constraints (scope/authorization/budget), output, Definition of Done. Cited msg#<N> messages and report:<agent-id> excerpts are appended, fenced; invalid or oversized references refuse the call.",
			}),
			item: Type.Optional(
				Type.String({
					description: "Backlog item you hold (ongoing); the child may update only it, and its report is noted there.",
				}),
			),
			resume: Type.Optional(
				Type.String({
					description:
						"Finished or stopped child id from this session: continue its saved conversation with this task and its original profile.",
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
						"Override: provider/id, bare id, small or medium, optional :thinking; unavailable choices refused. Default: profile model, else yours.",
				}),
			),
			resultSchema: Type.Optional(
				// A plain object schema: `Type.Record` would add a `patternProperties` block to every request for the same meaning.
				Type.Unsafe<Record<string, unknown>>({
					type: "object",
					description:
						"Bounded JSON Schema for the child's final marked JSON result (verdict in details). Keywords: type, properties, required, additionalProperties, items, enum, const, description, numeric/length bounds.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: "Return at once for independent work; report delivered automatically.",
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
						"Private worktree; changes export to refs/octocode/<id>. Report names the ref; user applies it with /agents merge <id>.",
				}),
			),
			workingCopy: Type.Optional(
				Type.Boolean({
					description:
						"With isolate: start from a snapshot of tracked and non-ignored untracked files; only the child's delta exports; conflicts keep the worktree for review.",
				}),
			),
		}),
	};
}
