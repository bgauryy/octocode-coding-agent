import type { Member } from "@octocodeai/octocode-contracts/team";
import { sharedAgentDb } from "../../storage/database.ts";
import { type EndpointDirectory, endpointOf } from "./endpoint.ts";
import { departedLookup } from "./feed-read.ts";
import type { EndpointResolver } from "./tools/message-rows.ts";

/** What a live session knows of the team: its own id and the members its ticker last read. */
export interface LiveTeam {
	readonly id: string | undefined;
	readonly view: { members: readonly Member[] };
}

/**
 * The live team's endpoint directory: members from the ticker's cached read, then the row an agent left behind (read from
 * the shared database on first need), with this session's checkout as `main`.
 */
function liveDirectory(team: LiveTeam, env: NodeJS.ProcessEnv = process.env): () => EndpointDirectory {
	let departed: ReturnType<typeof departedLookup> | undefined;
	return () => {
		const members = team.view.members;
		const root = members.find((member) => member.id === team.id)?.checkout;
		departed ??= departedLookup(sharedAgentDb(env).db);
		return { members, departed, ...(root ? { root } : {}) };
	};
}

/** `liveDirectory` as the transcript rows' resolver. */
export function liveEndpoints(team: LiveTeam, env?: NodeJS.ProcessEnv): EndpointResolver {
	const directory = liveDirectory(team, env);
	return (id) => endpointOf(id, directory());
}
