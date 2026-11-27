// Cursor keeps chats in three places, none of them a documented format:
// - ~/.cursor/projects/<path slug>/agent-transcripts/<id>.jsonl (or <id>/<id>.jsonl, older <id>.txt);
// - ~/.cursor/chats/<md5 of the workspace path>/<chat id>/store.db, the CLI agent's chats (tables meta, blobs);
// - the editor's <app data>/Cursor/User: workspaceStorage/<id>/workspace.json names the folder, and
//   globalStorage/state.vscdb holds composerHeaders (ItemTable) and composerData:/bubbleId: rows (cursorDiskKV).
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { exists, inScope, jsonLines, mtime, parseJson, readText, slugMatcher, sqlite, toolArg } from "./common.mjs";

const iso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : undefined);
const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;
const EDIT_TOOL = /edit|write|replace|apply/i;

function cursorAppData(home, env = process.env, platform = process.platform) {
	if (platform === "darwin") return join(home, "Library", "Application Support", "Cursor", "User");
	if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "User");
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "Cursor", "User");
}

/** `<user_query>text</user_query>` (how Cursor wraps the typed prompt) as the text; other context tags dropped. */
function userText(text) {
	const query = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
	if (query) return query[1].trim();
	return /^\s*<[a-z_]+>[\s\S]*<\/[a-z_]+>\s*$/.test(text) ? "" : text.trim();
}

/** Events from a message-shaped object: { role, content } or { role, message: { content } }. */
function messageEvents(message, events) {
	const role = message?.role;
	if (role !== "user" && role !== "assistant") return;
	const content = message.message?.content ?? message.content;
	const blocks =
		typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
	for (const block of blocks) {
		if (block?.type === "text" && typeof block.text === "string") {
			const text = role === "user" ? userText(block.text) : block.text.trim();
			if (text) events.push({ kind: role, text });
		} else if (role === "assistant" && (block?.type === "tool_use" || block?.type === "tool-call")) {
			const input = block.input ?? block.args;
			const name = block.name ?? block.toolName;
			events.push({ kind: "tool", name, arg: toolArg(input) });
			const path = input?.file_path ?? input?.target_file ?? input?.path;
			if (EDIT_TOOL.test(name ?? "") && typeof path === "string") events.push({ kind: "file", path });
		}
	}
}

const summarize = (base, events) => ({
	session: {
		harness: "cursor",
		...base,
		title: base.title || events.find((event) => event.kind === "user")?.text || "",
		userTurns: events.filter((event) => event.kind === "user").length,
	},
	events,
});

// --- agent transcripts ---

/**
 * Transcript folders named after a scope's path. A transcript records no directory, so a name must spell
 * the scope's path exactly; a prefix would also take a sibling project such as <repo>-old.
 */
function transcriptFolders(ctx) {
	const projects = join(ctx.home, ".cursor", "projects");
	if (!exists(projects)) return [];
	const out = [];
	for (const dir of readdirSync(projects, { withFileTypes: true })) {
		const folder = join(projects, dir.name, "agent-transcripts");
		const scope = ctx.scopes.find((candidate) => slugMatcher(candidate.path, true)(dir.name));
		if (dir.isDirectory() && scope && exists(folder)) out.push({ folder, scope });
	}
	return out;
}

function transcripts(ctx) {
	const out = [];
	for (const { folder, scope } of transcriptFolders(ctx)) {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const nested = join(folder, entry.name, `${entry.name}.jsonl`);
			if (entry.isDirectory() && exists(nested)) out.push({ id: entry.name, file: nested, scope });
			else if (entry.isFile() && /\.(jsonl|txt)$/.test(entry.name))
				out.push({ id: entry.name.replace(/\.(jsonl|txt)$/, ""), file: join(folder, entry.name), scope });
		}
	}
	return out;
}

const chatsFolder = (ctx, dir) => join(ctx.home, ".cursor", "chats", createHash("md5").update(dir).digest("hex"));

export function cursorLocations(ctx) {
	const app = cursorAppData(ctx.home, ctx.env, ctx.platform);
	const rows = transcriptFolders(ctx).map(({ folder }) => ({
		label: "Cursor transcripts",
		path: folder,
		exists: true,
	}));
	if (!rows.length)
		rows.push({
			label: "Cursor transcripts",
			path: join(ctx.home, ".cursor", "projects"),
			exists: false,
			detail: "no folder for this repository",
		});
	for (const scope of ctx.scopes) {
		const path = chatsFolder(ctx, scope.path);
		if (exists(path) || scope.kind === "root")
			rows.push({ label: "Cursor CLI chats", path, exists: exists(path), detail: `md5 of ${scope.path}` });
	}
	const ids = workspaceIds(ctx);
	rows.push({
		label: "Cursor editor workspaces",
		path: join(app, "workspaceStorage"),
		exists: exists(join(app, "workspaceStorage")),
		detail: `${ids.size} for this repository`,
	});
	rows.push({
		label: "Cursor editor chats",
		path: join(app, "globalStorage", "state.vscdb"),
		exists: exists(join(app, "globalStorage", "state.vscdb")),
	});
	return rows;
}

function parseTranscript({ id, file, scope }) {
	const root = scope.path;
	const events = [];
	if (file.endsWith(".jsonl")) {
		for (const record of jsonLines(readText(file))) messageEvents(record, events);
	} else {
		// Older plain-text transcripts: blocks introduced by a "user:" or "assistant:" line.
		for (const part of readText(file).split(/^(?=(?:user|assistant):\s*$)/m)) {
			const role = part.match(/^(user|assistant):/)?.[1];
			if (role) messageEvents({ role, content: part.replace(/^(user|assistant):\s*/, "") }, events);
		}
	}
	return summarize(
		{
			id,
			source: "transcript",
			cwd: root,
			scope,
			startedAt: statSync(file).birthtime.toISOString(),
			updatedAt: mtime(file),
			file,
			resume: { command: null, cwd: root, note: "Transcript only: continue here, or find the chat in Cursor." },
		},
		events,
	);
}

// --- CLI agent chats ---

function cliChats(ctx) {
	const out = [];
	for (const dir of new Set([...ctx.scopes.map((scope) => scope.path), ctx.cwd])) {
		const folder = chatsFolder(ctx, dir);
		if (!exists(folder)) continue;
		for (const chat of readdirSync(folder, { withFileTypes: true })) {
			const db = join(folder, chat.name, "store.db");
			if (chat.isDirectory() && exists(db)) out.push({ id: chat.name, file: db, cwd: dir });
		}
	}
	return out;
}

/** A meta or blob value: JSON, possibly stored as hex text. */
function decode(value) {
	if (typeof value !== "string") return undefined;
	return (
		parseJson(value) ?? (/^[0-9a-f]+$/i.test(value) ? parseJson(Buffer.from(value, "hex").toString("utf8")) : undefined)
	);
}

function parseCli(chat, withEvents, notes) {
	const rows = sqlite(chat.file, "select value from meta");
	if (!rows) return (notes.add("sqlite3 not found: Cursor chat databases were skipped."), undefined);
	const meta = rows.map((row) => decode(row.value)).find((value) => value && typeof value === "object") ?? {};
	const events = [];
	if (withEvents) {
		// Messages are JSON blobs among binary tree nodes; row order approximates conversation order.
		for (const row of sqlite(chat.file, "select hex(data) as h from blobs order by rowid") ?? []) {
			messageEvents(parseJson(Buffer.from(row.h, "hex").toString("utf8")), events);
		}
	}
	const result = summarize(
		{
			id: chat.id,
			source: "cli",
			title: meta.name,
			cwd: chat.cwd,
			startedAt: iso(meta.createdAt),
			updatedAt: mtime(chat.file),
			file: chat.file,
			resume: {
				command: `cursor-agent --resume ${chat.id}`,
				cwd: chat.cwd,
				note: "Newer installs name the CLI `agent`; check `command -v` first, other tools also install an `agent`.",
			},
		},
		events,
	);
	// Counting turns means reading every blob; a listing leaves it unknown.
	if (!withEvents) result.session.userTurns = null;
	return result;
}

// --- editor (composer) chats ---

function workspaceIds(ctx) {
	const storage = join(cursorAppData(ctx.home, ctx.env, ctx.platform), "workspaceStorage");
	const ids = new Map();
	if (!exists(storage)) return ids;
	for (const dir of readdirSync(storage, { withFileTypes: true })) {
		const info = join(storage, dir.name, "workspace.json");
		if (!dir.isDirectory() || !exists(info)) continue;
		const folder = parseJson(readText(info))?.folder;
		if (typeof folder === "string" && folder.startsWith("file://") && inScope(ctx, folder)) {
			ids.set(dir.name, decodeURIComponent(new URL(folder).pathname));
		}
	}
	return ids;
}

function composers(ctx, notes) {
	const ids = workspaceIds(ctx);
	const globalDb = join(cursorAppData(ctx.home, ctx.env, ctx.platform), "globalStorage", "state.vscdb");
	if (!ids.size || !exists(globalDb)) return { globalDb, heads: [] };
	const heads = [];
	const add = (list, workspace) => {
		for (const head of list ?? []) {
			const wid = head.workspaceIdentifier?.id ?? workspace;
			if (head.composerId && !head.isDraft && ids.has(wid)) heads.push({ ...head, cwd: ids.get(wid) });
		}
	};
	const rows = sqlite(globalDb, "select value from ItemTable where key = 'composer.composerHeaders'");
	if (!rows) return (notes.add("sqlite3 not found: Cursor chat databases were skipped."), { globalDb, heads });
	add(decode(rows[0]?.value)?.allComposers);
	// Older editors listed each workspace's chats in its own state.vscdb.
	for (const wid of ids.keys()) {
		const db = join(cursorAppData(ctx.home, ctx.env, ctx.platform), "workspaceStorage", wid, "state.vscdb");
		if (!exists(db)) continue;
		add(
			decode(sqlite(db, "select value from ItemTable where key = 'composer.composerData'")?.[0]?.value)?.allComposers,
			wid,
		);
	}
	const seen = new Set();
	return { globalDb, heads: heads.filter((head) => !seen.has(head.composerId) && seen.add(head.composerId)) };
}

function bubbleEvents(bubble, events) {
	if (!bubble) return;
	const text = typeof bubble.text === "string" ? bubble.text.trim() : "";
	if (bubble.type === 1 && text) events.push({ kind: "user", text });
	if (bubble.type === 2 && text) events.push({ kind: "assistant", text });
	const tool = bubble.toolFormerData;
	if (tool?.name) {
		const params = decode(tool.params) ?? decode(tool.rawArgs) ?? tool.params;
		events.push({ kind: "tool", name: tool.name, arg: toolArg(params) });
		const path = params?.target_file ?? params?.file_path ?? params?.relativeWorkspacePath;
		if (EDIT_TOOL.test(tool.name) && typeof path === "string") events.push({ kind: "file", path });
	}
}

function parseComposer(globalDb, head, withEvents) {
	const key = `composerData:${head.composerId}`;
	const data = decode(sqlite(globalDb, `select value from cursorDiskKV where key = ${quote(key)}`)?.[0]?.value) ?? {};
	const events = [];
	const order = data.fullConversationHeadersOnly ?? [];
	if (withEvents && order.length) {
		const prefix = `bubbleId:${head.composerId}:`;
		const rows = sqlite(globalDb, `select key, value from cursorDiskKV where key like ${quote(`${prefix}%`)}`) ?? [];
		const bubbles = new Map(rows.map((row) => [row.key.slice(prefix.length), decode(row.value)]));
		for (const entry of order) bubbleEvents(bubbles.get(entry.bubbleId), events);
	} else if (withEvents) {
		for (const bubble of data.conversation ?? []) bubbleEvents(bubble, events);
	}
	const turns = order.length
		? order.filter((entry) => entry.type === 1).length
		: (data.conversation ?? []).filter((b) => b.type === 1).length;
	const result = summarize(
		{
			id: head.composerId,
			source: "editor",
			title: head.name ?? data.name,
			cwd: head.cwd,
			startedAt: iso(head.createdAt ?? data.createdAt),
			updatedAt: iso(head.lastUpdatedAt ?? data.lastUpdatedAt),
			file: `${globalDb} (${key})`,
			resume: {
				command: null,
				cwd: head.cwd,
				note: "Editor chat: open it in Cursor's chat history; it has no CLI resume.",
			},
		},
		events,
	);
	if (!withEvents) result.session.userTurns = turns;
	return result;
}

function all(ctx, withEvents) {
	const notes = ctx.notes ?? new Set();
	const found = transcripts(ctx).map((entry) => parseTranscript(entry));
	for (const chat of cliChats(ctx)) {
		const parsed = parseCli(chat, withEvents, notes);
		if (parsed) found.push(parsed);
	}
	const { globalDb, heads } = composers(ctx, notes);
	for (const head of heads) found.push(parseComposer(globalDb, head, withEvents));
	// One chat can appear in several places under one id: keep the richest record, and a runnable resume.
	const byId = new Map();
	for (const entry of found) {
		const prior = byId.get(entry.session.id);
		if (!prior) {
			byId.set(entry.session.id, entry);
			continue;
		}
		const [rich, poor] = entry.session.userTurns > prior.session.userTurns ? [entry, prior] : [prior, entry];
		if (!rich.session.resume.command && poor.session.resume.command) rich.session.resume = poor.session.resume;
		rich.session.title ||= poor.session.title;
		byId.set(entry.session.id, rich);
	}
	const kept = [...byId.values()].filter(
		(entry) => entry.session.userTurns === null || entry.session.userTurns > 0 || entry.events.length > 0,
	);
	for (const { session } of kept) session.scope ??= inScope(ctx, session.cwd);
	return kept;
}

export const listCursor = async (ctx) =>
	all(ctx, false).map(({ session }) => ({ mtime: session.updatedAt ?? "", load: () => session }));
export const readCursor = async (ctx, id) => all(ctx, true).find((entry) => entry.session.id === id);
