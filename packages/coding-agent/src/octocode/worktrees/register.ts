import type { FeatureSetup } from "../../core/features/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { registerWorktreeCommand, type WorktreeCommandDependencies } from "./command.ts";
import type { ParkedResident } from "./occupants.ts";
import { registerWorktreeFooter, type WorktreeTeam } from "./footer.ts";
import { type NoticeTeam, registerOrchestratorNotice } from "./orchestrator-notice.ts";

/** The `/worktree` command, the footer line that shows the worktree and the agents in the others, and a linked session's done notice. */
export function registerWorktrees(
	api: FeatureSetup,
	commands: Subcommands,
	team: WorktreeTeam & NoticeTeam & { notice(text: string): unknown },
	parked?: () => ParkedResident[],
	merge?: WorktreeCommandDependencies["merge"],
): void {
	// The session's folder follows `/worktree switch` and `/resume`, which never change the process directory.
	let cwd: string | undefined;
	api.bus.on("session_start", async (_event, ctx) => void (cwd = ctx.cwd));
	registerWorktreeCommand(commands, {
		members: () => team.members(),
		parked,
		cwd: () => cwd,
		merge,
		agentId: () => team.id,
	});
	registerWorktreeFooter(api, team);
	// A linked worktree session is a proxy: it tells its orchestrator when an item is done.
	registerOrchestratorNotice(api, team, (text) => void team.notice(text));
}
