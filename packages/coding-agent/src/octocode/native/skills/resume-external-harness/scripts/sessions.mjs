#!/usr/bin/env node
// Lists and shows Claude Code, Codex, Cursor, Antigravity (agy) and Octocode sessions recorded for a repository and its worktrees, and
// reports the worktrees themselves. Read-only: it never writes to the other harnesses' folders, opens their
// SQLite files immutable, and only suggests git commands.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { agyLocations, listAgy, readAgy } from "./lib/antigravity.mjs";
import { claudeLocations, listClaude, readClaude } from "./lib/claude.mjs";
import { codexLocations, listCodex, readCodex } from "./lib/codex.mjs";
import { clip, digest, real, redact, repoRoot } from "./lib/common.mjs";
import { cursorLocations, listCursor, readCursor } from "./lib/cursor.mjs";
import { listOctocode, octocodeLocations, readOctocode } from "./lib/octocode.mjs";
import { printList, printLocations, printShow, printWorktrees, timing } from "./lib/render.mjs";
import { baseRef, inspectWorktree, worktrees } from "./lib/worktrees.mjs";

const HARNESSES = {
	claude: { list: listClaude, read: readClaude, locations: claudeLocations },
	codex: { list: listCodex, read: readCodex, locations: codexLocations },
	cursor: { list: listCursor, read: readCursor, locations: cursorLocations },
	agy: { list: listAgy, read: readAgy, locations: agyLocations },
	octocode: { list: listOctocode, read: readOctocode, locations: octocodeLocations },
};

const USAGE = `Usage:
  sessions.mjs list [--limit N] [--exact] [--archived] [common options]
  sessions.mjs show <harness:id | id | latest> [--turns N] [--chars N] [common options]
  sessions.mjs worktrees [common options]
  sessions.mjs locations [common options]

Common options: --cwd DIR (default: here), --harness claude,codex,cursor,agy,octocode, --root-only, --json

list       sessions whose directory is the repository of --cwd, a folder in it, or one of its worktrees;
           newest first, with timing (last activity, run length, LIVE? when written in the last 2 minutes)
show       one session as a digest: location, timing, summary, files edited, last --turns turns, resume command
worktrees  each worktree (registered, folder missing, or left behind unregistered) with its changes, commits
           ahead of the base branch, sessions that ran there and a suggested action
locations  the folders and databases searched for each harness, and the scopes that count as this repository
--exact      only sessions started in a scope's top folder, not its subfolders
--root-only  leave the repository's worktrees out
--archived   also Codex's archived_sessions (list; show always looks there)`;

function fail(message, code = 2) {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function context(values) {
	const cwd = real(resolve(values.cwd ?? process.cwd()));
	const ctx = {
		home: homedir(),
		env: process.env,
		platform: process.platform,
		cwd,
		root: repoRoot(cwd),
		exact: Boolean(values.exact),
		archived: Boolean(values.archived),
		notes: new Set(),
	};
	ctx.trees = worktrees(ctx);
	const trees = values["root-only"] ? ctx.trees.filter((tree) => tree.kind === "root") : ctx.trees;
	ctx.scopes = trees.map(({ path, kind, missing, branch }) => ({ path, kind, missing, branch }));
	return ctx;
}

function harnesses(values) {
	const names = values.harness ? values.harness.split(",").map((name) => name.trim()) : Object.keys(HARNESSES);
	const unknown = names.filter((name) => !HARNESSES[name]);
	if (unknown.length) fail(`Unknown harness: ${unknown.join(", ")} (known: ${Object.keys(HARNESSES).join(", ")})`);
	return names;
}

/** Sessions in file-time order, parsed only until `limit` are in scope; `skip` drops candidates unparsed. */
async function listAll(ctx, names, limit, skip = () => false) {
	const lists = await Promise.all(
		names.map(async (name) => {
			try {
				return (await HARNESSES[name].list(ctx)).map((candidate) => ({ ...candidate, name }));
			} catch (error) {
				ctx.notes.add(`${name}: ${error.message}`);
				return [];
			}
		}),
	);
	const candidates = lists.flat().filter((candidate) => !skip(candidate));
	candidates.sort((a, b) => b.mtime.localeCompare(a.mtime));
	const sessions = [];
	for (const candidate of candidates) {
		if (sessions.length >= limit) break;
		try {
			const session = candidate.load();
			if (session) sessions.push(session);
		} catch (error) {
			ctx.notes.add(`${candidate.name}: ${error.message}`);
		}
	}
	return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

async function resolveRef(ctx, names, ref) {
	if (ref === "latest") {
		const [newest] = await listAll(ctx, names, 1);
		return newest ? HARNESSES[newest.harness].read(ctx, newest.id) : undefined;
	}
	const split = ref.indexOf(":");
	const named = split > 0 && HARNESSES[ref.slice(0, split)];
	const [scope, id] = named ? [[ref.slice(0, split)], ref.slice(split + 1)] : [names, ref];
	for (const name of scope) {
		const found = await HARNESSES[name].read(ctx, id);
		if (found) return found;
	}
	return undefined;
}

function showResult(found, values) {
	const { session } = found;
	const { turns, summaries, files, errors } = digest(found.events);
	const keep = Math.max(1, Number(values.turns ?? 8));
	const chars = Math.max(100, Number(values.chars ?? 800));
	const first = turns.length - Math.min(keep, turns.length);
	const lastReply = [...turns]
		.reverse()
		.find((turn) => turn.assistant.length)
		?.assistant.at(-1);
	return {
		session: { ...session, title: redact(session.title ?? "") },
		timing: timing(session),
		totalTurns: turns.length,
		summaryCount: summaries.length,
		latestSummary: summaries.length ? redact(clip(summaries.at(-1), 6000)) : null,
		filesEdited: files,
		turns: turns.slice(first).map((turn, index) => ({
			turn: first + index + 1,
			user: redact(clip(turn.user, chars * 3)),
			assistant: redact(clip(turn.assistant.join("\n\n"), chars)),
			tools: turn.tools.map((tool) => redact(tool)),
		})),
		lastError: errors.length ? redact(clip(errors.at(-1), 1000)) : null,
		lastAssistantMessage: lastReply ? redact(clip(lastReply, 4000)) : null,
	};
}

async function worktreeReport(ctx, names) {
	const rootTree = ctx.trees.find((tree) => tree.kind === "root");
	const base = baseRef(ctx, rootTree?.branch);
	// Sessions outside the root's own folders; Codex knows a rollout's scope before parsing it.
	const sessions = await listAll(ctx, names, Number.POSITIVE_INFINITY, (candidate) => candidate.scope?.kind === "root");
	return {
		base,
		trees: ctx.trees.map((tree) => ({
			...inspectWorktree(ctx, tree, base),
			sessions: tree.kind === "root" ? undefined : sessions.filter((session) => session.scope?.path === tree.path),
		})),
	};
}

const slim = (session) => ({ ...session, timing: timing(session) });

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			cwd: { type: "string" },
			harness: { type: "string" },
			limit: { type: "string" },
			turns: { type: "string" },
			chars: { type: "string" },
			exact: { type: "boolean" },
			archived: { type: "boolean" },
			"root-only": { type: "boolean" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, ref] = positionals;
	if (values.help || !command) return console.log(USAGE);
	if (!["list", "show", "worktrees", "locations"].includes(command)) fail(USAGE);
	const ctx = context(values);
	const names = harnesses(values);
	const emit = (data, print) =>
		values.json ? console.log(JSON.stringify({ root: ctx.root, ...data, notes: [...ctx.notes] }, null, 2)) : print();
	if (command === "list") {
		const sessions = await listAll(ctx, names, Math.max(1, Number(values.limit ?? 15)));
		emit({ sessions: sessions.map(slim) }, () => printList(ctx, sessions, names));
	} else if (command === "show") {
		if (!ref) fail("show needs a session: <harness:id>, an id, or latest");
		const found = await resolveRef(ctx, names, ref);
		if (!found)
			fail(`No ${names.join("/")} session "${ref}" for ${ctx.root} or its worktrees; run list to see the ids.`, 1);
		const result = showResult(found, values);
		emit(result, () => printShow(ctx, result));
	} else if (command === "worktrees") {
		const report = await worktreeReport(ctx, names);
		emit(
			{ base: report.base, worktrees: report.trees.map((tree) => ({ ...tree, sessions: tree.sessions?.map(slim) })) },
			() => printWorktrees(ctx, report.trees, report.base),
		);
	} else {
		const rows = names.flatMap((name) => HARNESSES[name].locations(ctx));
		emit({ scopes: ctx.scopes, locations: rows }, () => printLocations(ctx, rows));
	}
	if (!values.json) for (const note of ctx.notes) console.log(`\nNote: ${note}`);
}

await main();
