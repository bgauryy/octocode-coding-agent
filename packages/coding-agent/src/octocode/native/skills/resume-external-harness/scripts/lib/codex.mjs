// Codex: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, first line `session_meta` with the cwd;
// names in <CODEX_HOME>/session_index.jsonl; archived rollouts (optionally .zst) in archived_sessions/.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	exists,
	firstLine,
	inScope,
	jsonLines,
	mapLimit,
	mtime,
	parseJson,
	patchFiles,
	readText,
	span,
	toolArg,
	zstdFirstLine,
} from "./common.mjs";

/**
 * Context Codex injects as user or developer messages (instructions, environment, aborted-turn markers), and
 * Claude Code's notices in sessions Codex imported from it.
 */
const INJECTED =
	/^\s*(<(environment_context|user_instructions|permissions instructions|skills_instructions|collaboration_mode|multi_agent_role|multi_agent_mode|turn_aborted|user_shell_command|task-notification|system-reminder|local-command-[a-z]+)\b|# AGENTS\.md instructions)/;
const ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/;

const codexHome = (home, env = process.env) => env.CODEX_HOME || join(home, ".codex");

function walk(dir, out = []) {
	if (!exists(dir)) return out;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (ID.test(entry.name)) out.push(path);
	}
	return out;
}

async function headOf(file) {
	if (!file.endsWith(".zst")) return parseJson(firstLine(file));
	return parseJson((await zstdFirstLine(file)) ?? "");
}

function names(home) {
	const index = join(home, "session_index.jsonl");
	const map = new Map();
	if (exists(index))
		for (const row of jsonLines(readText(index))) if (row.thread_name) map.set(row.id, row.thread_name);
	return map;
}

/** Threads Codex copied from another tool's transcript (`external_agent_session_imports.json`): id to source file. */
function imports(home) {
	const file = join(home, "external_agent_session_imports.json");
	const records = exists(file) ? parseJson(readText(file))?.records : undefined;
	return new Map((Array.isArray(records) ? records : []).map((row) => [row.imported_thread_id, row.source_path]));
}

/** Rollouts whose recorded cwd is in the repository or a worktree, with their head record. */
async function candidates(ctx) {
	const home = codexHome(ctx.home, ctx.env);
	const files = walk(join(home, "sessions"));
	if (ctx.archived) files.push(...walk(join(home, "archived_sessions")));
	const heads = await mapLimit(files, 32, headOf);
	const out = [];
	files.forEach((file, index) => {
		const head = heads[index];
		const meta = head?.type === "session_meta" ? head.payload : head;
		const scope = meta && inScope(ctx, meta.cwd);
		if (scope) out.push({ file, meta, scope, id: meta.id ?? file.match(ID)[1] });
	});
	return { home, out };
}

export function codexLocations(ctx) {
	const home = codexHome(ctx.home, ctx.env);
	return ["sessions", "archived_sessions", "session_index.jsonl"].map((name) => {
		const path = join(home, name);
		const count = name.endsWith(".jsonl") ? undefined : walk(path).length;
		return {
			label: `Codex ${name}`,
			path,
			exists: exists(path),
			detail: count === undefined ? "session names" : `${count} rollouts, all repositories`,
		};
	});
}

function messageText(content) {
	if (typeof content === "string") return content;
	return (Array.isArray(content) ? content : [])
		.map((block) => (typeof block?.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function parse({ file, meta, id, scope }, title, importedFrom) {
	const events = [];
	const times = [meta.timestamp];
	let branch = meta.git?.branch;
	for (const record of jsonLines(readText(file))) {
		times.push(record.timestamp);
		// Early rollouts wrote items bare; current ones wrap them as { type: "response_item", payload }.
		const item = record.type === "response_item" ? record.payload : record.role || record.call_id ? record : undefined;
		if (record.type === "compacted" && typeof record.payload?.message === "string" && record.payload.message.trim()) {
			events.push({ kind: "summary", text: record.payload.message });
		}
		if (record.type === "turn_context" && record.payload?.git?.branch) branch = record.payload.git.branch;
		if (!item) continue;
		if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
			const body = messageText(item.content).trim();
			if (!body || (item.role === "user" && INJECTED.test(body))) continue;
			events.push({ kind: item.role, text: body });
		} else if (item.type === "function_call") {
			const args = parseJson(item.arguments) ?? item.arguments;
			events.push({ kind: "tool", name: item.name, arg: toolArg(args) });
		} else if (item.type === "custom_tool_call") {
			events.push({
				kind: "tool",
				name: item.name,
				arg: toolArg(item.name === "apply_patch" ? patchFiles(item.input) : item.input),
			});
			if (item.name === "apply_patch") for (const path of patchFiles(item.input)) events.push({ kind: "file", path });
		} else if (item.type === "local_shell_call") {
			events.push({ kind: "tool", name: "shell", arg: toolArg(item.action?.command) });
		}
	}
	const firstPrompt = events.find((event) => event.kind === "user")?.text;
	const { startedAt, updatedAt } = span(times);
	return {
		session: {
			harness: "codex",
			id,
			title: title ?? firstPrompt ?? "",
			cwd: meta.cwd,
			scope,
			branch,
			startedAt,
			updatedAt: updatedAt ?? mtime(file),
			userTurns: events.filter((event) => event.kind === "user").length,
			file,
			archived: file.includes("archived_sessions") || undefined,
			importedFrom,
			resume: {
				command: `codex resume ${id}`,
				cwd: meta.cwd,
				note: `Non-interactive: codex exec resume ${id} "<prompt>".`,
			},
		},
		events,
	};
}

/** Rollouts in scope (judged from their first line) with their modification time; `load` parses one. */
export async function listCodex(ctx) {
	const { home, out } = await candidates(ctx);
	let titles;
	let copied;
	return out.map((candidate) => ({
		mtime: mtime(candidate.file),
		scope: candidate.scope,
		load: () =>
			parse(candidate, (titles ??= names(home)).get(candidate.id), (copied ??= imports(home)).get(candidate.id))
				.session,
	}));
}

export async function readCodex(ctx, id) {
	const { home, out } = await candidates({ ...ctx, archived: true });
	const match = out.find((candidate) => candidate.id === id);
	return match ? parse(match, names(home).get(id), imports(home).get(id)) : undefined;
}
