import type { ExtensionAPI } from "../../core/extensions/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { registerWorktreeCommand } from "./command.ts";
import type { ParkedResident } from "./occupants.ts";
import { registerWorktreeFooter, type WorktreeTeam } from "./footer.ts";

/** The `/worktree` command and the footer line that shows the worktree and the agents in the others. */
export function registerWorktrees(
	api: ExtensionAPI,
	commands: Subcommands,
	team: WorktreeTeam,
	parked?: () => ParkedResident[],
): void {
	// The session's folder follows `/worktree switch` and `/resume`, which never change the process directory.
	let cwd: string | undefined;
	api.on("session_start", async (_event, ctx) => void (cwd = ctx.cwd));
	registerWorktreeCommand(commands, { members: () => team.members(), parked, cwd: () => cwd });
	registerWorktreeFooter(api, team);
}
