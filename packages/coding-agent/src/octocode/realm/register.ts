import type { Member } from "@octocodeai/octocode-contracts/team";
import type { FeatureSetup } from "../../core/features/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { realmCommand } from "./command.ts";
import { catalogSessions } from "./sessions.ts";
import { SessionIndex } from "../sessions/store.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../../storage/database.ts";

/** The `/realm` command: this process's session, place and children, with `places` for the repository's checkouts and worktrees. */
export function registerRealm(
	api: FeatureSetup,
	commands: Subcommands,
	team: { id?: string | undefined; members(): Member[] },
	serving: () => Iterable<readonly [string, string]>,
): void {
	const index = () => new SessionIndex(sharedAgentDb(), () => sharedAgentDbWriter());
	// The session's folder follows `/worktree switch` and `/resume`, which never change the process directory.
	let cwd: string | undefined;
	api.bus.on("session_start", async (_event, ctx) => void (cwd = ctx.cwd));
	commands.add(
		"realm",
		realmCommand({
			members: () => team.members(),
			sessions: catalogSessions(index),
			cwd: () => cwd,
			realm: { id: () => team.id, members: () => team.members(), serving },
		}),
	);
}
