// Wiring that hands the team to its other surfaces: the sessions registry, the collaboration tools' shell checks and the external API.
import type { FeatureSetup } from "../core/features/index.ts";
import { AGENT_GOAL_ENV } from "./team/store/env.ts";
import type { Checkpoints } from "./files/checkpoint.ts";
import { registerApi } from "./api/register.ts";
import type { ExternalAgents } from "./external/manager.ts";
import type { messagePolicy } from "./message-policy.ts";
import type { Permission } from "./permission/ask.ts";
import { parsedShell, reservationTargets, shellMutation, shellParserReady } from "./permission/shell/mutation.ts";
import { readOnlyCommand } from "./permission/shell/read-only.ts";
import { describeWorktrees } from "./worktrees/summary.ts";
import type { registerPlanning } from "./plan/register.ts";
import { registerRealm } from "./realm/register.ts";
import { registerSessions } from "./sessions/register.ts";
import type { Subcommands } from "./shared/commands.ts";
import { EXTERNAL_SENDER } from "./shared/messages.ts";
import type { Team } from "./team/session.ts";
import { packageVersion } from "./ui/chrome.ts";
import { spilledMessage } from "./team/session/spilled-message.ts";
import { onParentGone } from "./team/session/parent.ts";
import { saveParentGoneReport } from "./subagents/handoff/parent-gone.ts";

export function registerTeamSessions(
	api: FeatureSetup,
	team: Team,
	checkpoints: Checkpoints,
	options: { commands: Subcommands; isSubagent: boolean },
): void {
	registerSessions(api, {
		...options,
		...(options.isSubagent && process.env[AGENT_GOAL_ENV] ? { goal: process.env[AGENT_GOAL_ENV] } : {}),
		filesChanged: () => new Set(checkpoints.list().map((entry) => entry.path)).size,
		team: {
			reservations: () => team.members().find((member) => member.id === team.id)?.locks ?? [],
			questions: () =>
				team
					.openQuestions()
					.filter((question) => question.recipient === team.id)
					.map(({ id, from, text }) => ({ id, from, text })),
		},
	});
	// A subagent whose parent died files its own stop report before it exits: nobody else is left to.
	if (options.isSubagent) onParentGone(saveParentGoneReport);
	// `/realm` reads the team and the session catalog; a subagent has no command line to type it in.
	if (!options.isSubagent) registerRealm(api, options.commands, team);
}

/** The shell checks the collaboration tools run before a command: its reservation targets, read-only status and changes. */
export function collaborationPorts() {
	return {
		describeWorktrees,
		shellWrites: (command: string) => shellParserReady().then(() => reservationTargets(command)),
		shellReadOnly: readOnlyCommand,
		shellCommands: parsedShell,
		shellChanges: async (command: string) => {
			await shellParserReady();
			return shellMutation(command).writes;
		},
	};
}

/** The external API of a top-level session: the team's agents, message hooks, turn cap and external calls. */
export function registerExternalApi(
	api: FeatureSetup,
	commands: Subcommands,
	parts: {
		team: Team;
		messaging: ReturnType<typeof messagePolicy>;
		permission: Permission;
		planning: ReturnType<typeof registerPlanning>;
		external: () => ExternalAgents | undefined;
	},
) {
	const { team, messaging, permission, planning } = parts;
	return registerApi(
		api,
		commands,
		{
			list: () => team.members(),
			tell: (to, text) => team.send(to, text, { from: EXTERNAL_SENDER }),
			deliverable: spilledMessage,
		},
		packageVersion,
		{
			messageSend: messaging.inboundHooks,
			admit: messaging.admit,
			capTurn: (ceiling) => permission.turnCap.set(ceiling),
			externalCall: (input, ctx) => {
				if (planning.blocked()) throw new Error("External agent calls are unavailable during planning.");
				return parts.external()!.call(input, ctx);
			},
		},
	);
}
