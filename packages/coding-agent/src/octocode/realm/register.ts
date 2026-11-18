import type { Member } from "@octocodeai/octocode-contracts/team";
import type { FeatureSetup } from "../../core/features/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { realmCommand } from "./command.ts";
import { catalogSessions } from "./sessions.ts";
import { SessionIndex } from "../sessions/store.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../../storage/database.ts";

/** The `/realm` command: this repository's checkout, worktrees and sessions in one view. */
export function registerRealm(api: FeatureSetup, commands: Subcommands, team: { members(): Member[] }): void {
	const index = () => new SessionIndex(sharedAgentDb(), () => sharedAgentDbWriter());
	// The session's folder follows `/worktree switch` and `/resume`, which never change the process directory.
	let cwd: string | undefined;
	api.bus.on("session_start", async (_event, ctx) => void (cwd = ctx.cwd));
	commands.add(
		"realm",
		realmCommand({ members: () => team.members(), sessions: catalogSessions(index), cwd: () => cwd }),
	);
}
