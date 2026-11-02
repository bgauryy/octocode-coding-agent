import { agentEvents, agents, compactions, sharedAgentDb } from "../agentdb/api.ts";
import { memoryStore, describeMemory, noMemory, memoryToolLine } from "../memory/store.ts";
import { sessionWorkspace } from "../shared/home/workspace.ts";
import { matchTexts, HISTORY_BYTES } from "../shared/history-search.ts";
import { ownArchives } from "../shared/archive.ts";
import { workspaceHistoryScope } from "../shared/history.ts";
import path from "node:path";

const SOURCES = ["memories", "compactions", "events", "agents", "sessions"] as const;
type DataSource = (typeof SOURCES)[number];
export interface ReadParams extends agentEvents.EventFilter {
	source?: string;
	op?: string;
	id?: string;
	query?: string;
	keywords?: string;
	cursor?: string;
	limit?: number;
	scope?: "workspace" | "project" | "global" | "all";
	page?: number;
}
interface Position {
	seq: number;
	pinned?: number;
	updated?: number;
	offset?: number;
}
interface RecordHit {
	id: string;
	seq: number;
	text: string;
	source: DataSource;
	position?: Position;
	score?: number;
	preview?: string;
}
type Cursor = Partial<Record<DataSource, Position>>;

function cursorOf(value: string | undefined): Cursor {
	if (!value) return {};
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
		for (const [source, before] of Object.entries(parsed)) {
			if (
				!SOURCES.includes(source as DataSource) ||
				!before ||
				typeof before !== "object" ||
				!Number.isSafeInteger(before.seq) ||
				before.seq < 0 ||
				(before.pinned !== undefined && ![0, 1, 2].includes(before.pinned)) ||
				(before.updated !== undefined && !Number.isSafeInteger(before.updated)) ||
				(before.offset !== undefined && (!Number.isSafeInteger(before.offset) || before.offset < 0))
			)
				throw new Error();
		}
		return parsed;
	} catch {
		throw new Error("Invalid archive cursor; restart the search without cursor.");
	}
}

function summaryText(row: compactions.SummaryRow): string {
	return `${row.summary}\n\nDetail: ${row.detailState}${row.detailState === "present" && row.detailFile ? ` (${row.detailFile})` : ""}`;
}

export function getRecord(cwd: string, id: string, store = memoryStore(cwd)): string {
	if (/^M\d+$/.test(id)) {
		const memory = store.get(Number(id.slice(1)));
		if (!memory) throw noMemory(Number(id.slice(1)));
		store.markUsed([memory.id]);
		return describeMemory(memory);
	}
	const agent = sharedAgentDb();
	const workspace = sessionWorkspace(cwd);
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
		const history = workspaceHistoryScope(cwd).find((row) => row.id === sessionId);
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

/** Each source has a keyset cursor. Search coverage is explicit: later pages cannot be hidden by a recent window. */
export async function readRecords(
	cwd: string,
	params: ReadParams,
	signal?: AbortSignal,
	store = memoryStore(cwd),
): Promise<{
	text: string;
	cursor?: string;
	hits: number;
}> {
	const cursor = cursorOf(params.cursor);
	const selected = params.source === "all" || !params.source ? [...SOURCES] : [params.source as DataSource];
	const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));
	const agent = sharedAgentDb();
	const workspace = sessionWorkspace(cwd);
	const own = ownArchives().map((folder) => path.basename(path.dirname(folder)));
	const collected: RecordHit[] = [];
	const scanned = new Map<DataSource, number>();
	let remaining = HISTORY_BYTES;
	for (const source of selected) {
		signal?.throwIfAborted();
		if (!SOURCES.includes(source)) continue;
		const before = cursor[source]?.seq ?? Number.MAX_SAFE_INTEGER;
		if (before === 0 || remaining === 0) continue;
		let rows: RecordHit[];
		if (source === "memories") {
			const ranked = params.keywords
				? store.searchPage(params.keywords, params.scope ?? "all", cursor[source]?.offset ?? 0, limit + 1)
				: undefined;
			const notes =
				ranked ??
				store.scan(
					params.scope ?? "all",
					{
						id: before,
						pinned: cursor[source]?.pinned ?? 2,
						updated: cursor[source]?.updated ?? Number.MAX_SAFE_INTEGER,
					},
					limit + 1,
				);
			rows = notes.map((row, i) => ({
				id: `M${row.id}`,
				seq: row.id,
				text: describeMemory(row),
				preview: memoryToolLine(row, 160),
				source,
				position: {
					seq: row.id,
					pinned: Number(row.pinned),
					updated: row.updatedAt,
					...(ranked ? { offset: (cursor[source]?.offset ?? 0) + i + 1 } : {}),
				},
				...(ranked ? { score: ranked[i].score } : {}),
			}));
		} else if (source === "events")
			rows = agentEvents
				.list(agent.db, workspace, before, limit + 1, params)
				.map((row) => ({ id: `event:${row.id}`, seq: row.seq, text: JSON.stringify(row), source }));
		else if (source === "compactions")
			rows = compactions.visible(agent.db, workspace, own, before, limit + 1, params.keywords).map((row) => ({
				id: `compaction:${row.sessionId}:${row.entryId}`,
				seq: row.seq,
				text: summaryText(row),
				source,
			}));
		else if (source === "sessions")
			rows = compactions
				.sessionIndex(agent.db, workspace, own, before, limit + 1)
				.map((row) => ({ id: `session:${row.sessionId}`, seq: row.seq, text: JSON.stringify(row), source }));
		else
			rows = agents
				.inWorkspace(agent.db, workspace)
				.map((row, i, all) => ({
					id: `agent:${String(row.id)}`,
					seq: all.length - i,
					text: JSON.stringify(row),
					source,
				}))
				.filter((row) => row.seq < before)
				.slice(0, limit + 1);
		let batch = rows.slice(0, limit);
		let bytes = 0;
		const bounded: RecordHit[] = [];
		for (const row of batch) {
			const size = Buffer.byteLength(row.text);
			if (size > HISTORY_BYTES) throw new Error(`${row.id} exceeds the search budget; get it directly by id.`);
			if (bytes + size > remaining) break;
			bytes += size;
			bounded.push(row);
		}
		batch = bounded;
		cursor[source] =
			rows.length > batch.length ? (batch.at(-1)?.position ?? { seq: batch.at(-1)?.seq ?? before }) : { seq: 0 };
		remaining -= bytes;
		collected.push(...batch);
		scanned.set(source, batch.length);
	}
	let matches = collected;
	if (params.query) {
		const found = await matchTexts(
			collected.map((row) => row.text),
			new RegExp(params.query, "i"),
			signal,
		);
		matches = collected.filter((_, i) => found.has(i));
	}
	if (params.keywords?.trim()) {
		const words = params.keywords.toLowerCase().split(/\s+/).filter(Boolean);
		matches = matches
			.map((row) => ({
				...row,
				score: row.score ?? words.reduce((sum, word) => sum + (row.text.toLowerCase().includes(word) ? 1 : 0), 0),
			}))
			.filter((row) => row.score > 0)
			.sort((a, b) => b.score - a.score || b.seq - a.seq);
	}
	if (params.op === "search") store.markUsed(matches.filter((row) => row.source === "memories").map((row) => row.seq));
	const groups = selected.map((source) => {
		const batch = matches.filter((row) => row.source === source);
		return `${source}: ${batch.length} matches in ${scanned.get(source) ?? 0} scanned records on this page\n${batch
			.map(
				(row) =>
					`${row.id}\n${row.preview ?? `${row.text.slice(0, 800)}${row.text.length > 800 ? "… (get by id)" : ""}`}`,
			)
			.join("\n\n")}`;
	});
	const more = selected.some((source) => cursor[source]?.seq !== 0);
	return {
		text: groups.join("\n\n"),
		hits: matches.length,
		...(more ? { cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url") } : {}),
	};
}
