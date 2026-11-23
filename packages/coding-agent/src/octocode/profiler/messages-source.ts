import fs from "node:fs";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { Db } from "../../../../db/src/api.ts";
import type { CommandContext } from "../../core/features/index.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { FeedNotice } from "../team/feed.ts";
import { teamFeedSource } from "../team/feed-read.ts";
import type { Team } from "../team/session.ts";
import type { MessagesData } from "../team/messages/page.ts";
import { teamScope } from "../team/store/workspace.ts";
import { parseTranscript, prepare } from "./entries.ts";
import { internalNotices, transcriptNear } from "./notices.ts";
import { projectEntry } from "./transcript-read.ts";
import { memberTranscript } from "./transcripts.ts";

/** What `/messages` reads: the shared database, the team, the viewer and its own session file. */
export interface MessagesSources {
	db: Db;
	/** The team id (`teamScope`). */
	team: string;
	members: () => readonly Member[];
	/** The viewer's checkout, so its folder is `main`. */
	root?: string;
	/** The viewer's own session file, for notices its transcript holds. */
	ownFile?: () => string | undefined;
	ownId?: string;
}

/** A transcript parsed once while its file is unchanged. */
class TranscriptCache {
	private readonly parsed = new Map<string, { stamp: string; value: ReturnType<typeof prepare> }>();

	/** A session's file is written with its first message: before that its transcript is empty, not an error. */
	read(file: string): ReturnType<typeof prepare> {
		const stat = fs.statSync(file, { throwIfNoEntry: false });
		if (!stat) return prepare([]);
		const stamp = `${stat.mtimeMs}:${stat.size}`;
		const cached = this.parsed.get(file);
		if (cached?.stamp === stamp) return cached.value;
		const value = prepare(parseTranscript(fs.readFileSync(file, "utf8")));
		this.parsed.set(file, { stamp, value });
		return value;
	}
}

/** The page's ports: the feed (notices read only when asked) and the transcript reader. */
export function messagesPorts(sources: MessagesSources): MessagesData {
	const cache = new TranscriptCache();
	const fileOf = (id: string, sessionId?: string): string | undefined =>
		(id === sources.ownId ? sources.ownFile?.() : undefined) ??
		memberTranscript(sources.db, { id, ...(sessionId ? { sessionId } : {}) });
	const notices = (): FeedNotice[] => {
		const files = new Map<string, string>();
		for (const member of sources.members()) {
			const file = fileOf(member.id, member.sessionId);
			if (file) files.set(member.id, file);
		}
		const own = sources.ownId ? fileOf(sources.ownId) : undefined;
		if (sources.ownId && own) files.set(sources.ownId, own);
		return [...files].flatMap(([id, file]) => internalNotices(id, cache.read(file)));
	};
	return {
		feed: teamFeedSource({
			db: sources.db,
			team: sources.team,
			members: sources.members,
			...(sources.root ? { root: sources.root } : {}),
			notices,
			transcriptNear: (agentId, at) => {
				const file = fileOf(agentId);
				return file ? transcriptNear(agentId, cache.read(file), at) : undefined;
			},
		}),
		transcript: (ref) => {
			const file = fileOf(ref.agentId, ref.sessionId);
			const entry = file ? cache.read(file).entries[ref.entry] : undefined;
			return entry ? projectEntry(entry, ref.entry) : undefined;
		},
	};
}

/** The ports of `/messages` for this session: the shared database, the team its folder belongs to, the live members and its own session file. */
export function liveMessagesData(
	ctx: Pick<CommandContext, "cwd" | "sessionManager">,
	team: Pick<Team, "id" | "members">,
	env: NodeJS.ProcessEnv = process.env,
): MessagesData {
	const members = () => team.members();
	const root = members().find((member) => member.id === team.id)?.checkout;
	return messagesPorts({
		db: sharedAgentDb(env).db,
		team: teamScope(ctx.cwd, env),
		members,
		...(root ? { root } : {}),
		...(team.id ? { ownId: team.id } : {}),
		ownFile: () => ctx.sessionManager.getSessionFile(),
	});
}
