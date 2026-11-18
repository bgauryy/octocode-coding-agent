// Claude Code: one JSONL per session in <config>/projects/<cwd with non-alphanumerics as "-">/<session-id>.jsonl.
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { exists, inScope, jsonLines, mtime, readText, slugInScope, span, toolArg } from "./common.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** User records that the app injected rather than the person typed. */
const INJECTED =
	/^\s*<(task-notification|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr)\b/;
const CONTINUED = /^This session is being continued from a previous conversation/;

const claudeHome = (home, env = process.env) => env.CLAUDE_CONFIG_DIR || join(home, ".claude");

/** Project folders whose name encodes the repository root or one of its worktrees. */
function projectDirs(ctx) {
	const projects = join(claudeHome(ctx.home, ctx.env), "projects");
	if (!exists(projects)) return [];
	return readdirSync(projects, { withFileTypes: true })
		.filter((dir) => dir.isDirectory() && slugInScope(ctx, dir.name))
		.map((dir) => join(projects, dir.name));
}

export function claudeLocations(ctx) {
	const projects = join(claudeHome(ctx.home, ctx.env), "projects");
	const dirs = projectDirs(ctx);
	return [
		{
			label: "Claude Code projects",
			path: projects,
			exists: exists(projects),
			detail: `${dirs.length} folders for this repository`,
		},
		...dirs.map((dir) => ({
			label: "  project",
			path: dir,
			exists: true,
			detail: `${sessionFilesIn(dir).length} sessions`,
		})),
	];
}

const sessionFilesIn = (dir) =>
	readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => join(dir, entry.name));

function sessionFiles(ctx) {
	const files = [];
	for (const dir of projectDirs(ctx)) {
		// Subagent transcripts live in <session>/subagents/; only top-level files are resumable sessions.
		files.push(...sessionFilesIn(dir));
	}
	return files;
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** `<command-name>/x</command-name>…<command-args>y</command-args>` as the person typed it: `/x y`. */
function slashCommand(text) {
	const name = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1];
	if (!name) return undefined;
	const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "";
	return `${name.startsWith("/") ? name : `/${name}`} ${args}`.trim();
}

function parse(file) {
	const meta = { id: basename(file, ".jsonl"), file, titles: {} };
	const events = [];
	const times = [];
	for (const record of jsonLines(readText(file))) {
		if (record.type === "ai-title" && record.aiTitle) meta.titles.ai = record.aiTitle;
		if (record.type === "custom-title" && record.customTitle) meta.titles.custom = record.customTitle;
		if (record.type === "summary" && record.summary) meta.titles.summary ??= record.summary;
		if (record.isSidechain || (record.type !== "user" && record.type !== "assistant")) continue;
		meta.cwd ??= record.cwd;
		if (record.gitBranch) meta.branch = record.gitBranch;
		times.push(record.timestamp);
		const content = record.message?.content;
		if (record.type === "user") {
			if (record.isMeta) continue;
			const text = textOf(content).trim();
			if (!text || INJECTED.test(text) || text.startsWith("[Request interrupted")) continue;
			if (record.isCompactSummary || CONTINUED.test(text)) events.push({ kind: "summary", text });
			else events.push({ kind: "user", text: slashCommand(text) ?? text });
			continue;
		}
		for (const block of Array.isArray(content) ? content : []) {
			if (block?.type === "text" && block.text?.trim()) events.push({ kind: "assistant", text: block.text });
			if (block?.type !== "tool_use") continue;
			events.push({ kind: "tool", name: block.name, arg: toolArg(block.input) });
			const path = block.input?.file_path ?? block.input?.notebook_path;
			if (EDIT_TOOLS.has(block.name) && path) events.push({ kind: "file", path });
		}
	}
	const firstPrompt = events.find((event) => event.kind === "user")?.text;
	return {
		session: {
			harness: "claude",
			id: meta.id,
			title: meta.titles.custom ?? meta.titles.ai ?? meta.titles.summary ?? firstPrompt ?? "",
			cwd: meta.cwd,
			branch: meta.branch,
			...span(times),
			updatedAt: span(times).updatedAt ?? mtime(file),
			userTurns: events.filter((event) => event.kind === "user").length,
			file,
			resume: {
				command: `claude --resume ${meta.id}`,
				cwd: meta.cwd,
				note: "Run it from the session's directory: Claude Code keys sessions by working directory.",
			},
		},
		events,
	};
}

/** Session files with their modification time; `load` parses one and drops it when its cwd is outside the scope. */
export async function listClaude(ctx) {
	return sessionFiles(ctx).map((file) => ({
		mtime: mtime(file),
		load: () => {
			const { session } = parse(file);
			session.scope = inScope(ctx, session.cwd);
			return session.scope ? session : undefined;
		},
	}));
}

export async function readClaude(ctx, id) {
	const file = sessionFiles(ctx).find((candidate) => basename(candidate, ".jsonl") === id);
	if (!file) return undefined;
	const found = parse(file);
	found.session.scope = inScope(ctx, found.session.cwd);
	return found;
}
