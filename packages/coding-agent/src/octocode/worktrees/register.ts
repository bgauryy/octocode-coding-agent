import type { ExtensionAPI } from "../../core/extensions/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { registerWorktreeCommand } from "./command.ts";
import { registerWorktreeFooter, type WorktreeTeam } from "./footer.ts";

/** The `/worktree` command and the footer line that shows the worktree and the agents in the others. */
export function registerWorktrees(api: ExtensionAPI, commands: Subcommands, team: WorktreeTeam): void {
	registerWorktreeCommand(commands, { members: () => team.members() });
	registerWorktreeFooter(api, team);
}
