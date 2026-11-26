// Antigravity CLI (`agy`): conversations indexed in <home>/conversation_summaries.db (title, workspaces, times,
// parent links; FTS chunks of user and agent text with per-step byte offsets), prompts in history.jsonl, and
// one step database per conversation in conversations/<id>.db (protobuf blobs; only its final error is read) and
// the step transcript brain/<id>/.system_generated/logs/transcript.jsonl.
import { statSync } from "node:fs";
import { join } from "node:path";
import { lastError, transcriptEvents } from "./antigravity-steps.mjs";
import { exists, inScope, jsonLines, readText, sqlite } from "./common.mjs";

const agyHome = (home) => join(home, ".gemini", "antigravity-cli");
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
const MISSING = "sqlite3 not found: Antigravity conversations were skipped.";

/** `2026-11-25 14:32:21.98+00:00` as ISO; the zero time Antigravity writes for "never" is undefined. */
function iso(time) {
	const ms = Date.parse(String(time ?? "").replace(" ", "T"));
	return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

const uriPath = (uri) => (uri.startsWith("file://") ? decodeURIComponent(new URL(uri).pathname) : uri);

/** Typed prompts per conversation id from history.jsonl, oldest first, with their times; slash commands left out. */
function prompts(home) {
	const file = join(agyHome(home), "history.jsonl");
	const byId = new Map();
	if (!exists(file)) return byId;
	for (const record of jsonLines(readText(file))) {
		if (!record.conversationId || typeof record.display !== "string" || record.display.startsWith("/")) continue;
		const list = byId.get(record.conversationId) ?? [];
		list.push({
			text: record.display,
			at: Number.isFinite(record.timestamp) ? new Date(record.timestamp).toISOString() : undefined,
		});
		byId.set(record.conversationId, list);
	}
	return byId;
}

export function agyLocations(ctx) {
	const home = agyHome(ctx.home);
	const db = join(home, "conversation_summaries.db");
	const rows = exists(db)
		? sqlite(db, "select count(*) as n from conversation_summaries where parent_conversation_id = ''")
		: undefined;
	return [
		{ label: "Antigravity home", path: home, exists: exists(home), detail: "" },
		{
			label: "  summaries",
			path: db,
			exists: exists(db),
			detail: rows ? `${rows[0]?.n ?? 0} top-level conversations (all workspaces)` : exists(db) ? MISSING : "",
		},
		{ label: "  prompts", path: join(home, "history.jsonl"), exists: exists(join(home, "history.jsonl")), detail: "" },
	];
}

/** `anywhere`: a conversation asked for by id is read even when it ran outside the repository and its worktrees. */
function session(ctx, row, history, anywhere = false) {
	const uris = JSON.parse(row.workspace_uris || "[]").map(uriPath);
	let cwd;
	let scope;
	for (const path of uris) {
		scope = inScope(ctx, path);
		if (scope) {
			cwd = path;
			break;
		}
	}
	if (!scope && !anywhere) return undefined;
	cwd ??= uris[0];
	const asked = history.get(row.conversation_id) ?? [];
	const file = join(agyHome(ctx.home), "conversations", `${row.conversation_id}.db`);
	const born = exists(file) ? statSync(file).birthtime.toISOString() : undefined;
	const startedAt = [asked[0]?.at, born].filter(Boolean).sort((a, b) => a.localeCompare(b))[0];
	return {
		harness: "agy",
		id: row.conversation_id,
		title: row.title || row.preview || asked[0]?.text || "",
		cwd,
		scope,
		outside: scope ? undefined : true,
		startedAt,
		updatedAt: iso(row.last_modified_time) ?? iso(row.last_user_input_time),
		userTurns: asked.length || null,
		file,
		resume: {
			command: `agy --conversation ${row.conversation_id}`,
			cwd,
			note: "Run it from the session's workspace so its tools act on the same folder.",
		},
	};
}

function rows(ctx, where) {
	const db = join(agyHome(ctx.home), "conversation_summaries.db");
	if (!exists(db)) return [];
	const found = sqlite(
		db,
		`select conversation_id, title, preview, workspace_uris, last_modified_time, last_user_input_time
		 from conversation_summaries where parent_conversation_id = '' and ${where}`,
	);
	if (!found) ctx.notes?.add(MISSING);
	return found ?? [];
}

/** One body split into its steps: offsets are [step index, byte offset] pairs into the UTF-8 text. */
function steps(body, offsets, kind, out) {
	const bytes = Buffer.from(body ?? "", "utf8");
	const marks = JSON.parse(offsets || "[]");
	marks.forEach(([step, start], index) => {
		const end = index + 1 < marks.length ? marks[index + 1][1] : bytes.length;
		const text = bytes.subarray(start, end).toString("utf8").trim();
		if (text) out.push({ step, kind, text });
	});
}

/**
 * (No transcript) User and agent text in step order from the search index (it holds no tool calls), then the prompts history.jsonl
 * has that the index has not caught up with yet; their replies are only in the step database.
 */
function indexEvents(ctx, id, asked) {
	const db = join(agyHome(ctx.home), "conversation_summaries.db");
	const chunks =
		sqlite(
			db,
			`select user_body, agent_body, user_step_byte_offsets as u, agent_step_byte_offsets as a
			 from conversations_fts where conversation_id = ${quote(id)} and chunk_index >= 0 order by chunk_index`,
		) ?? [];
	const found = [];
	for (const chunk of chunks) {
		steps(chunk.user_body, chunk.u, "user", found);
		steps(chunk.agent_body, chunk.a, "assistant", found);
	}
	found.sort((x, y) => x.step - y.step);
	const indexed = new Set(found.filter((event) => event.kind === "user").map((event) => event.text));
	const late = asked.filter(({ text }) => !indexed.has(text.trim()));
	return [...found, ...late.map(({ text }) => ({ kind: "user", text }))].map(({ kind, text }) => ({ kind, text }));
}

/** The transcript's steps when the conversation has one, else the search index; then the error the run ended on. */
function events(ctx, id, asked) {
	const home = agyHome(ctx.home);
	const found = transcriptEvents(home, id) ?? indexEvents(ctx, id, asked);
	const error = lastError(join(home, "conversations", `${id}.db`));
	return error ? [...found, { kind: "error", text: error.text }] : found;
}

export async function listAgy(ctx) {
	const history = prompts(ctx.home);
	return rows(ctx, "1")
		.map((row) => session(ctx, row, history))
		.filter(Boolean)
		.map((found) => ({ mtime: found.updatedAt ?? "", load: () => found }));
}

export async function readAgy(ctx, id) {
	const history = prompts(ctx.home);
	const [row] = rows(ctx, `conversation_id = ${quote(id)}`);
	const found = row && session(ctx, row, history, true);
	return found ? { session: found, events: events(ctx, id, history.get(id) ?? []) } : undefined;
}
