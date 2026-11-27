import { type AgentDb, backlog } from "../../../../db/src/api.ts";
import { classify } from "../shared/backlog-classify.ts";
import type { BacklogChange } from "../shared/backlog-change.ts";
import type { BacklogDeps } from "./conditions/types.ts";

/** Audit rows read per query while catching up from a stored cursor. */
const PAGE = 500;
const ALL_STATES = ["backlog", "todo", "ongoing", "done", "closed"];

/** `B12` or `12` as the item number, or undefined. */
const seqOf = (ref: string) => {
	const seq = /^\s*(?:[bB]|#)?(\d{1,9})\s*$/.exec(ref)?.[1];
	return seq === undefined ? undefined : Number(seq);
};

export interface BacklogDepsHost {
	db: () => AgentDb;
	/** The workspace the audit log and board are read for. */
	workspace: () => string;
	own: (by: string) => boolean;
	/** The change feed this process runs, or undefined: a subagent follows none. */
	subscribe?: BacklogDeps["subscribe"];
}

/** The backlog reads of the waits (`item`, `changed`, `landed`) over the shared database; the feed is the host's. */
export function backlogDeps(host: BacklogDepsHost): BacklogDeps {
	return {
		head: () => backlog.snapshot(host.db().db, host.workspace()).cursor,
		since(since) {
			const changes: BacklogChange[] = [];
			let cursor = since;
			for (;;) {
				const page = backlog.auditAfter(host.db().db, host.workspace(), cursor, PAGE);
				if (page.resync) return { changes: [], resync: true };
				for (const row of page.rows) {
					const change = classify(row);
					if (change) changes.push(change);
				}
				cursor = page.cursor;
				if (!page.more) return { changes, resync: false };
			}
		},
		under(epic) {
			const seq = seqOf(epic);
			const row = seq === undefined ? undefined : backlog.itemBySeq(host.db().db, host.workspace(), seq);
			if (!row) return undefined;
			return backlog
				.listItems(host.db().db, { repo: host.workspace(), states: ALL_STATES, underItem: row.id }, -1, 0)
				.map((item) => `B${item.seq}`);
		},
		detail(ref) {
			const seq = seqOf(ref);
			const row = seq === undefined ? undefined : backlog.itemBySeq(host.db().db, host.workspace(), seq);
			if (!row) return undefined;
			return {
				state: row.closed === null ? row.state : "closed",
				assignee: row.assignee,
				paths: row.paths.split("\n").filter(Boolean),
			};
		},
		own: host.own,
		...(host.subscribe ? { subscribe: host.subscribe } : {}),
	};
}
