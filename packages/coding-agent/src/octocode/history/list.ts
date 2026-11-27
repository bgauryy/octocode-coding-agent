import path from "node:path";
import { plural } from "../shared/text.ts";
import type { RecordHeader } from "./archive/record.ts";
import { type HistoryPage, type HistorySession, historyFiles, paginate } from "./transcripts.ts";

/** A session's record labels on one line: when it was last active, its name, goal and ending. */
function recordFacts(record: RecordHeader | undefined): string[] {
	return [
		...(record?.lastActive ? [`last active ${record.lastActive}`] : []),
		...(record?.name ? [`name ${record.name}`] : []),
		...(record?.goal ? [`goal: ${record.goal}`] : []),
		...(record?.ended ? [`ended: ${record.ended}`] : []),
	];
}

/** Sessions one page of the index lists without `limit`. */
const SESSIONS_PER_PAGE = 10;

interface HistoryList extends HistoryPage {
	/** What the list holds and how to go deeper. */
	head: string;
}

/**
 * The sessions in scope, paged. Without `focus`, an index of `perPage` sessions a page: one line per session with its
 * record's labels (its ending is in its own listing) and segment count, the subagent sessions of a listed session
 * counted on its line rather than listed. With `focus` (a session id,
 * `current` for this one), that session's files (record, then segments newest first, with their TL;DR) and one line for
 * each of its subagent sessions.
 */
export function listHistory(
	sessions: readonly HistorySession[],
	page = 1,
	focus?: string,
	perPage = SESSIONS_PER_PAGE,
): HistoryList {
	const children = new Map<string, HistorySession[]>();
	const ids = new Set(sessions.map((session) => session.id));
	for (const session of sessions) {
		const parent = session.record?.parent;
		if (parent && ids.has(parent) && session.relation === "same repository")
			children.set(parent, [...(children.get(parent) ?? []), session]);
	}
	const isChild = (session: HistorySession) =>
		session.relation === "same repository" && !!session.record?.parent && ids.has(session.record.parent);
	const line = (session: HistorySession) => {
		const agents = children.get(session.id)?.length ?? 0;
		const facts = [
			...recordFacts(session.record).filter((fact) => !fact.startsWith("ended: ")),
			plural(session.segments.length, "segment"),
			...(agents > 0 ? [plural(agents, "subagent session")] : []),
		];
		return `- ${session.id} (${session.relation}) · ${facts.join(" · ")}`;
	};
	const pageOf = (blocks: Array<{ heading?: string; lines: string[] }>) => {
		const pages = paginate(blocks);
		const index = Math.min(Math.max(page, 1), pages.length);
		return { text: pages[index - 1] ?? "", page: index, pages: pages.length };
	};
	if (focus) {
		const session = sessions.find((entry) =>
			focus === "current" ? entry.relation === "this session" : entry.id === focus,
		);
		if (!session) throw new Error(`No session ${focus} in this history; list the sessions without sessionId.`);
		const files = historyFiles([session]).map((file) => `- ${path.basename(file.file)} · ${file.label}`);
		const facts = recordFacts(session.record);
		const agents = (children.get(session.id) ?? []).map(line);
		return {
			head: `Session ${session.id}: its files (read one with file and line, search them with keywords or query and sessionId)${agents.length ? " and its subagent sessions" : ""}.`,
			...pageOf([
				{
					heading: `## ${session.id} (${session.relation}) · ${session.folder}`,
					lines: [...(facts.length > 0 ? [facts.join(" · ")] : []), ...files],
				},
				...(agents.length > 0 ? [{ heading: "## Subagent sessions", lines: agents }] : []),
			]),
		};
	}
	const shown = sessions.filter((session) => !isChild(session));
	const hidden = sessions.length - shown.length;
	const size = Math.max(1, Math.floor(perPage));
	const pages = Math.max(1, Math.ceil(shown.length / size));
	const index = Math.min(Math.max(page, 1), pages);
	return {
		head: `${plural(sessions.length, "session")} with history, nearest first${hidden ? `; ${plural(hidden, "subagent session")} counted on their parent's line` : ""}. List one session's files, ending and subagent sessions with sessionId; search them with keywords (ranked) or query (regex).`,
		text: shown
			.slice((index - 1) * size, index * size)
			.map(line)
			.join("\n"),
		page: index,
		pages,
	};
}
