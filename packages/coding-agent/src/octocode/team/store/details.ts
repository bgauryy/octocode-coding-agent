import fs from "node:fs";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { agentRuns, backlog, type Db, sessions } from "../../../../../db/src/api.ts";
import { sessionFolder } from "../../shared/home.ts";
import { liveItemJobs } from "../../shared/job-records.ts";

/**
 * What `coordinate list` adds per agent beyond its row: the backlog item it works on (a subagent's from its run, a
 * session's from the ongoing items assigned to it) and that item's why, its transcript folder and its shell-log folder.
 * Each field is absent when nothing records it; all of it is other processes' text, which the reader sanitizes.
 */
export interface MemberDetails {
	item?: { seq: number; title: string; why: string; more: number };
	/** The folder its conversation is saved in (`sessions.dir`). */
	transcripts?: string;
	/** The folder its background and trimmed shell output goes to, when it exists. */
	shellLogs?: string;
	/** Background bash jobs running now that name a backlog item (`bash` `item`): work on that item. */
	jobs?: { id: string; item: string }[];
}

/** The backlog item `member` works on in `workspaceId`, with how many more ongoing items a session holds. */
function itemOf(db: Db, workspaceId: string, member: Member): MemberDetails["item"] {
	const run = member.parentId ? agentRuns.latest(db, member.id)?.backlog : undefined;
	const held =
		run || !member.sessionId
			? []
			: backlog.ongoingItems(db, workspaceId, member.sessionId).map((row) => ({ workspaceId, seq: row.seq }));
	const ref = run ?? held[0];
	const row = ref && backlog.itemBySeq(db, ref.workspaceId, ref.seq);
	return row ? { seq: row.seq, title: row.title, why: row.why, more: Math.max(0, held.length - 1) } : undefined;
}

/** The folder `member`'s shell logs go to, when it exists: its session's `bash/` folder in its own checkout. */
function shellLogsOf(member: Member): string | undefined {
	if (!member.sessionId) return undefined;
	const folder = sessionFolder("bash", member.sessionId, process.env, member.checkout);
	return fs.existsSync(folder) ? folder : undefined;
}

/** The details of each of `members`, by id; a member with none has no entry. `machine` holds the session rows. */
export function memberDetails(
	db: Db,
	machine: Db,
	workspaceId: string,
	members: readonly Member[],
): Map<string, MemberDetails> {
	const details = new Map<string, MemberDetails>();
	for (const member of members) {
		const item = itemOf(db, workspaceId, member);
		const transcripts = member.sessionId ? (sessions.byId(machine, member.sessionId)?.dir ?? undefined) : undefined;
		const shellLogs = shellLogsOf(member);
		const jobs = shellLogs ? liveItemJobs(shellLogs) : [];
		const found: MemberDetails = {
			...(item ? { item } : {}),
			...(jobs.length > 0 ? { jobs } : {}),
			...(transcripts ? { transcripts } : {}),
			...(shellLogs ? { shellLogs } : {}),
		};
		if (Object.keys(found).length > 0) details.set(member.id, found);
	}
	return details;
}
