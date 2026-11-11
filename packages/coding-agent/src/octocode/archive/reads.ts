import { agentEvents, agents, compactions } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { registeredWorkspace } from "../../storage/workspace-database.ts";
import { matchTexts, HISTORY_BYTES } from "../history/search.ts";
import { ownArchives } from "../history/archive.ts";
import { historyScope } from "../history/transcripts.ts";
import path from "node:path";
import { splitSummary } from "../../core/compaction/summary-view.ts";
import { summarySection, TLDR_HEADING } from "../../core/compaction/summary-format.ts";
import { plural } from "../shared/text.ts";

const SOURCES = ["compactions", "events", "agents", "sessions"] as const;
type DataSource = (typeof SOURCES)[number];
export interface ReadParams extends agentEvents.EventFilter {
	source?: string;
	op?: string;
	id?: string;
	query?: string;
	keywords?: string;
	cursor?: string;
	limit?: number;
	/** False in a subagent: `all` leaves out lifecycle events, which only the main session reads. */
	diagnostics?: boolean;
}
interface Position {
	seq: number;
}
interface RecordHit {
	id: string;
	seq: number;
	/** The whole record, as a search tests it and `get` returns it. */
	text: string;
	/** Its index line for a listing. */
	line: string;
	source: DataSource;
}
type Cursor = Partial<Record<DataSource, Position>>;

function cursorOf(value: string | undefined): Cursor {
	if (!value) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString());
	} catch {
		parsed = undefined;
	}
	if (!isCursor(parsed)) throw new Error("Invalid archive cursor; restart the search without cursor.");
	return parsed;
}

function isCursor(parsed: unknown): parsed is Cursor {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	return Object.entries(parsed).every(
		([source, before]) =>
			SOURCES.includes(source as DataSource) &&
			before &&
			typeof before === "object" &&
			Number.isSafeInteger(before.seq) &&
			before.seq >= 0,
	);
}

function summaryText(row: compactions.SummaryRow): string {
	return `${row.summary}\n\nDetail: ${row.detailState}${row.detailState === "present" && row.detailFile ? ` (${row.detailFile})` : ""}`;
}

export function getRecord(cwd: string, id: string): string {
	const agent = sharedAgentDb();
	const workspace = registeredWorkspace(cwd, agent).id;
	if (id.startsWith("event:")) {
		const event = agentEvents.get(agent.db, workspace, id.slice(6));
		if (event) return JSON.stringify(event, null, 2);
	} else if (id.startsWith("compaction:")) {
		const [, sessionId, entryId] = id.split(":");
		const row = sessionId && entryId ? compactions.get(agent.db, sessionId, entryId) : undefined;
		const own = new Set(ownArchives().map((folder) => path.basename(path.dirname(folder))));
		if (row && (row.workspace === workspace || own.has(row.sessionId))) return summaryText(row);
	} else if (id.startsWith("session:")) {
		const sessionId = id.slice(8);
		const history = historyScope(cwd).find((row) => row.id === sessionId);
		const own = new Set(ownArchives().map((folder) => path.basename(path.dirname(folder))));
		const summaries = compactions
			.forSession(agent.db, sessionId)
			.filter((row) => row.workspace === workspace || own.has(sessionId));
		if (summaries.length || history)
			return JSON.stringify(
				{
					id,
					record: history?.record,
					compactions: summaries.map((row) => ({
						id: `compaction:${sessionId}:${row.entryId}`,
						committedAt: row.committedAt,
						detailState: row.detailState,
					})),
				},
				null,
				2,
			);
	} else if (id.startsWith("agent:")) {
		const row = agents.inWorkspace(agent.db, workspace).find((entry) => entry.id === id.slice(6));
		if (row) return JSON.stringify(row, null, 2);
	}
	throw new Error("No visible archive record with that id.");
}

/** Records one filtered read tests per batch, in the search worker. */
const FILTER_BATCH = 500;
/** The most records one read returns per source; a larger `limit` is capped, and the result says so. */
export const MAX_RECORDS = 50;
/** Records per source a read returns without `limit`. */
const DEFAULT_RECORDS = 10;
/** Records per source a listing of every source (the overview) returns without `limit`. */
export const OVERVIEW_RECORDS = 5;
/** Characters of a search hit's text shown before its id points to the rest (`get`). */
const HIT_CHARS = 800;

const firstLine = (text: string | null | undefined): string =>
	(text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean) ?? "";
const isoTime = (ms: number | null | undefined): string | undefined =>
	typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
/** One index line of a record: its id and named fields, each `label value`, empty fields left out. */
const indexLine = (id: string, fields: Array<string | undefined | false>): string =>
	[id, ...fields.filter((field): field is string => typeof field === "string" && field !== "")].join(" · ");
const field = (label: string, value: unknown): string | undefined =>
	typeof value === "string" || typeof value === "number" ? (value === "" ? undefined : `${label} ${value}`) : undefined;

/** A source's rows below `before` (newest first), at most `count`, each with its full text and its index line. */
function sourceRows(
	source: DataSource,
	scope: { db: ReturnType<typeof sharedAgentDb>["db"]; workspace: string; own: string[] },
	before: number,
	count: number,
	params: ReadParams,
): RecordHit[] {
	const { db, workspace, own } = scope;
	if (source === "events")
		return agentEvents.list(db, workspace, before, count, params).map((row) => ({
			id: `event:${row.id}`,
			seq: row.seq,
			text: JSON.stringify(row),
			line: indexLine(`event:${row.id}`, [
				row.time,
				row.type,
				field("agent", row.name),
				field("session", row.sessionId),
			]),
			source,
		}));
	if (source === "compactions")
		return compactions.visible(db, workspace, own, before, count, params.keywords).map((row) => {
			const id = `compaction:${row.sessionId}:${row.entryId}`;
			const tldr = summarySection(splitSummary(row.summary).body, TLDR_HEADING)
				.filter((line) => !/^topics:/i.test(line))
				.map((line) => line.replace(/^\s*(?:[-*]\s+)?/, "").trim())
				.join(" ");
			return {
				id,
				seq: row.seq,
				text: summaryText(row),
				line: indexLine(id, [isoTime(row.committedAt), tldr || firstLine(row.summary)]),
				source,
			};
		});
	if (source === "sessions")
		return compactions.sessionIndex(db, workspace, own, before, count).map((row) => {
			const id = `session:${row.sessionId}`;
			return {
				id,
				seq: row.seq,
				text: JSON.stringify(row),
				line: indexLine(id, [field("last compaction", isoTime(row.committedAt))]),
				source,
			};
		});
	return agents
		.inWorkspace(db, workspace)
		.map((row, i, all) => {
			const id = `agent:${String(row.id)}`;
			return {
				id,
				seq: all.length - i,
				text: JSON.stringify(row),
				line: indexLine(id, [
					field("role", row.role),
					field("status", row.status),
					field("parent", row.parent_id),
					field("model", row.model),
					field("task:", firstLine(row.task as string | null)),
				]),
				source,
			};
		})
		.filter((row) => row.seq < before)
		.slice(0, count);
}

/**
 * Records of the selected sources, newest first, each source with a keyset cursor. Without `query` or `keywords` a read
 * lists `limit` records per source, one index line each (`get` an id for the whole record). With them it searches: every
 * record of a source is tested, in batches, until `limit` match or the sources run out (or the byte budget does), so
 * a match is never hidden behind a page; matches show the start of their text. A source's line says how many records it
 * searched and whether any remain; the cursor exists only while one does.
 */
export async function readRecords(
	cwd: string,
	params: ReadParams,
	signal?: AbortSignal,
): Promise<{
	text: string;
	cursor?: string;
	hits: number;
}> {
	const cursor = cursorOf(params.cursor);
	// The overview leaves out the session index: the session-history part lists the same sessions with their goals.
	const selected =
		params.source === "all" || !params.source
			? SOURCES.filter(
					(source) =>
						(source !== "events" || params.diagnostics !== false) &&
						(source !== "sessions" || !!params.query?.trim() || !!params.keywords?.trim()),
				)
			: [params.source as DataSource];
	const all = params.source === "all" || !params.source;
	const listing = !params.query?.trim() && !params.keywords?.trim();
	// The default listing of every source is an overview: fewer records of each.
	const limit = Math.min(
		MAX_RECORDS,
		Math.max(1, Math.floor(params.limit ?? (all && listing ? OVERVIEW_RECORDS : DEFAULT_RECORDS))),
	);
	const agent = sharedAgentDb();
	const scope = {
		db: agent.db,
		workspace: registeredWorkspace(cwd, agent).id,
		own: ownArchives().map((folder) => path.basename(path.dirname(folder))),
	};
	const regex = params.query?.trim() ? new RegExp(params.query.trim(), "i") : undefined;
	const words = params.keywords?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
	const filtered = regex !== undefined || words.length > 0;
	const groups: string[] = [];
	let hits = 0;
	let remaining = HISTORY_BYTES;
	for (const source of selected) {
		signal?.throwIfAborted();
		if (!SOURCES.includes(source)) continue;
		let before = cursor[source]?.seq ?? Number.MAX_SAFE_INTEGER;
		if (before === 0 || remaining === 0) continue;
		const matches: Array<RecordHit & { score: number }> = [];
		let searched = 0;
		let ended = false;
		while (matches.length < limit && remaining > 0) {
			signal?.throwIfAborted();
			// A listing reads one page; a search reads batches until enough match.
			const want = filtered ? FILTER_BATCH : limit;
			const rows = sourceRows(source, scope, before, want + 1, params);
			const batch: RecordHit[] = [];
			for (const row of rows.slice(0, want)) {
				const size = Buffer.byteLength(row.text);
				if (size > HISTORY_BYTES) throw new Error(`${row.id} exceeds the search budget; get it directly by id.`);
				if (size > remaining) {
					remaining = 0;
					break;
				}
				remaining -= size;
				batch.push(row);
			}
			const found = regex
				? await matchTexts(
						batch.map((row) => row.text),
						regex,
						signal,
					)
				: undefined;
			let stopped = false;
			for (const [index, row] of batch.entries()) {
				searched++;
				before = row.seq;
				const lower = words.length > 0 ? row.text.toLowerCase() : "";
				const score = words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0);
				if ((!found || found.has(index)) && (words.length === 0 || score > 0)) matches.push({ ...row, score });
				if (matches.length >= limit) {
					stopped = index < batch.length - 1 || rows.length > want;
					break;
				}
			}
			ended = !stopped && remaining > 0 && rows.length <= want && batch.length === Math.min(rows.length, want);
			if (ended || !filtered || matches.length >= limit) break;
		}
		cursor[source] = { seq: ended ? 0 : before };
		if (words.length > 0) matches.sort((a, b) => b.score - a.score || b.seq - a.seq);
		hits += matches.length;
		const coverage = ended ? "every record" : "more remain";
		const shown = filtered
			? matches.map(
					(row) => `${row.id}\n${row.text.slice(0, HIT_CHARS)}${row.text.length > HIT_CHARS ? "… (get by id)" : ""}`,
				)
			: matches.map((row) => row.line);
		groups.push(
			filtered
				? `${source}: ${matches.length === 0 ? "no match" : plural(matches.length, "match")} in ${plural(searched, "record")} searched (${coverage})${shown.length ? `\n${shown.join("\n\n")}` : ""}`
				: `${source}: ${plural(matches.length, "record")}${ended ? "" : ", newest first; more remain"}${shown.length ? ` (get one by id)\n${shown.join("\n")}` : ""}`,
		);
	}
	const more = selected.some((source) => cursor[source]?.seq !== 0);
	return {
		text: groups.join("\n\n"),
		hits,
		...(more ? { cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") } : {}),
	};
}
