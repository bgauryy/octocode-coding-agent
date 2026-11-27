// Octocode: one JSONL per session in <workspace>/.octocode/agent/sessions/<time>_<id>.jsonl, where the workspace is
// the repository root or a worktree (each has its own folder). The first line is the session header.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, inScope, jsonLines, mtime, patchFiles, readText, span, toolArg } from "./common.mjs";

const ID = /_([0-9a-f-]{36})\.jsonl$/;
/** The source tag Octocode puts before a typed prompt: `[src terminal:terminal ✓proven via terminal] t4`. */
const SOURCE_TAG = /^\[src [^\]\n]*\]\s*(?:t\d+)?\s*\n?/;

const sessionDir = (scope) => join(scope.path, ".octocode", "agent", "sessions");

function sessionFiles(ctx) {
	const files = [];
	for (const scope of ctx.scopes) {
		const dir = sessionDir(scope);
		if (scope.missing || !exists(dir)) continue;
		for (const name of readdirSync(dir)) if (ID.test(name)) files.push(join(dir, name));
	}
	return files;
}

export function octocodeLocations(ctx) {
	return ctx.scopes.map((scope) => {
		const dir = sessionDir(scope);
		const found = exists(dir) ? readdirSync(dir).filter((name) => ID.test(name)).length : 0;
		return { label: "Octocode sessions", path: dir, exists: exists(dir), detail: `${found} sessions` };
	});
}

function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Paths the `file` tool changed: query edits, writes and deletes, and patch targets. */
function editedPaths(args) {
	const paths = (args?.queries ?? [])
		.filter((query) => query?.type !== "read" && query?.path)
		.map((query) => query.path);
	return args?.patch ? [...paths, ...patchFiles(args.patch)] : paths;
}

function parse(ctx, file) {
	const events = [];
	const times = [];
	let header;
	let name;
	for (const record of jsonLines(readText(file))) {
		if (record.type === "session") header ??= record;
		if (record.type === "session_info" && record.name) name = record.name;
		if (record.timestamp) times.push(record.timestamp);
		if (record.type === "compaction" && record.summary) events.push({ kind: "summary", text: record.summary });
		const message = record.type === "message" ? record.message : undefined;
		if (message?.role === "user") {
			const text = textOf(message.content).replace(SOURCE_TAG, "").trim();
			if (text) events.push({ kind: "user", text });
		} else if (message?.role === "assistant") {
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (block?.type === "text" && block.text?.trim()) events.push({ kind: "assistant", text: block.text });
				if (block?.type !== "toolCall") continue;
				const edited = block.name === "file" ? editedPaths(block.arguments) : [];
				const arg = edited.length ? toolArg(edited) : toolArg(block.arguments);
				events.push({ kind: "tool", name: block.name, arg });
				for (const path of edited) events.push({ kind: "file", path });
			}
		}
	}
	const id = header?.id ?? file.match(ID)[1];
	const cwd = header?.cwd;
	const current = ctx.env.OCTOCODE_SESSION_ID === id;
	return {
		session: {
			harness: "octocode",
			id,
			title: name ?? events.find((event) => event.kind === "user")?.text ?? "",
			cwd,
			scope: inScope(ctx, cwd),
			...span(times),
			updatedAt: span(times).updatedAt ?? mtime(file),
			userTurns: events.filter((event) => event.kind === "user").length,
			source: current ? "this session" : undefined,
			file,
			resume: {
				command: `octocode --resume ${id}`,
				cwd,
				note: "Run it from the session's workspace: elsewhere Octocode offers to fork it instead; inside Octocode, /resume picks it from a list.",
			},
		},
		events,
	};
}

export async function listOctocode(ctx) {
	return sessionFiles(ctx).map((file) => ({
		mtime: mtime(file),
		load: () => {
			const { session } = parse(ctx, file);
			return session.scope ? session : undefined;
		},
	}));
}

export async function readOctocode(ctx, id) {
	const file = sessionFiles(ctx).find((candidate) => candidate.match(ID)[1] === id);
	return file ? parse(ctx, file) : undefined;
}
