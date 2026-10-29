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
			"Delegate a self-contained task to a fresh Octocode session that does not inherit this conversation. " +
			`Foreground returns the report; background returns the agent's name, the report arrives later. At most ${maxSubagents()} at once; more wait. ` +
			"Never poll or sleep for reports. " +
			"A subagent updates only claimed backlog items: claim one first, name its id in the task.",
		parameters: Type.Object({
			skills: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Skill command names; omit to inherit the loaded catalog, [] to disable. Name required workflows in task.",
				}),
			),
			goal: Type.String({ description: GOAL_DESCRIPTION }),
			task: Type.String({
				description:
					"Task contract: objective; inputs it cannot infer (paths, evidence, decisions); constraints (scope, authorization, budget); output; Definition of Done",
			}),
			resume: Type.Optional(
				Type.String({
					description:
						"Id of a finished or stopped subagent this session started: continues its saved conversation with this task (same profile) instead of a fresh session; an unknown id is refused with this session's subagents",
				}),
			),
			profile: Type.Optional(
				Type.String({
					description: "Profile from the active Profiles list; omit for general-purpose",
				}),
			),
			headless: Type.Optional(
				Type.Boolean({
					description: "Browser profile: true headless (default); false visible Chrome with persistent logins",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						"Model override: provider/id, bare id or purpose (small, medium), optional :thinking. Refused when unavailable; omit for the profile's model, else this session's",
				}),
			),
			resultSchema: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description:
						"Bounded JSON Schema for the child's final marked JSON result (verdict in details). Keywords: type, properties, required, additionalProperties, items, enum, const, description, numeric/length bounds.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description: "Return at once for long or parallel work; message redirects it, coordinate stop ends it",
				}),
			),
			collaborate: Type.Optional(
				Type.Boolean({
					description:
						"true on each call of subagents that must coordinate directly (name each one's owner in the task); false otherwise",
				}),
			),
			isolate: Type.Optional(
				Type.Boolean({
					description:
						"Private git worktree: changes land on refs/octocode/pi/<id>, not in this tree; the report names the ref, the user runs /agents merge <id>",
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
