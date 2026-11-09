// Text views of sessions, worktrees and storage locations. JSON output is built in sessions.mjs.
import { relative } from "node:path";
import { ago, clip, duration, isLive, redact } from "./common.mjs";

const pad = (n) => String(n).padStart(2, "0");
/** Local wall-clock time, minutes precision. */
function localTime(time) {
	const date = new Date(time);
	if (!time || Number.isNaN(date.getTime())) return "unknown";
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const oneLine = (text, max) => redact(clip(String(text ?? "").replace(/\s+/g, " "), max));
const where = (root, dir) => (dir ? relative(root, dir) || "." : "?");

/** Start, last activity, run length and whether the other harness may still be writing it. */
export function timing(session, now = Date.now()) {
	const ran = Date.parse(session.updatedAt) - Date.parse(session.startedAt);
	return {
		startedAt: session.startedAt,
		updatedAt: session.updatedAt,
		idle: session.updatedAt ? ago(session.updatedAt, now) : "unknown",
		// An imported copy's timestamps are the import's, not the work's.
		ran: session.importedFrom ? "unknown (imported copy)" : Number.isFinite(ran) ? duration(ran) : "unknown",
		live: Boolean(session.updatedAt && isLive(session.updatedAt, now)),
	};
}

/** Where the session ran: the root, a subfolder, or a worktree (and whether that folder still exists). */
function location(root, session) {
	const scope = session.scope;
	const at = where(root, session.cwd);
	const copy = session.importedFrom ? `, imported from ${session.importedFrom}` : "";
	if (!scope || scope.kind === "root") return `repo ${at}${copy}`;
	const state = scope.missing ? ", folder deleted" : scope.kind === "unregistered" ? ", not registered with git" : "";
	return `${scope.kind === "unregistered" ? "stray worktree" : "worktree"} ${at}${scope.branch ? ` [${scope.branch}]` : ""}${state}${copy}`;
}

/** The native resume command, or why there is none, adjusted for a worktree whose folder is gone. */
function resumeLine(session) {
	const { command, cwd, note } = session.resume;
	if (session.scope?.missing) {
		return `restore the worktree first (\`git worktree add ${session.scope.path} ${session.scope.branch ?? "<ref>"}\`), then ${command ?? "continue here"}${command ? ` from ${cwd}` : ""}`;
	}
	return command ? `${command} (from ${cwd})` : `(none) - ${note}`;
}

export function printList(ctx, sessions, names) {
	const trees = ctx.scopes.length - 1;
	console.log(
		`Sessions for ${ctx.root}${trees ? ` and its ${trees} worktrees` : ""} (${names.join(", ")}), newest first: ${sessions.length}`,
	);
	for (const s of sessions) {
		const t = timing(s);
		const turns = s.userTurns === null ? "? turns" : `${s.userTurns} turns`;
		const tag = s.source ? ` [${s.source}]` : s.archived ? " [archived]" : "";
		console.log(`\n${s.harness}:${s.id}${tag}${t.live ? "  LIVE?" : ""}`);
		console.log(`  ${localTime(s.updatedAt)} (${t.idle}), ran ${t.ran}, ${turns}, ${location(ctx.root, s)}`);
		if (s.title) console.log(`  ${oneLine(s.title, 140)}`);
		console.log(`  resume: ${resumeLine(s)}`);
	}
	if (sessions.some((s) => timing(s).live)) {
		console.log("\nLIVE? = written in the last two minutes: the other harness may still be running it.");
	}
}

export function printShow(ctx, result) {
	const { session, timing: t } = result;
	console.log(`# ${session.harness}:${session.id}${session.title ? ` - ${oneLine(session.title, 120)}` : ""}\n`);
	console.log(
		`- Location: ${location(ctx.root, session)}; directory ${session.cwd ?? "unknown"}${session.branch ? `, branch ${session.branch}` : ""}`,
	);
	console.log(
		`- Timing: started ${localTime(t.startedAt)}, last activity ${localTime(t.updatedAt)} (${t.idle}), ran ${t.ran}; ${result.totalTurns} user turns`,
	);
	if (t.live) {
		console.log(
			"- LIVE?: written in the last two minutes. The other harness may still be running it: do not resume it natively or edit its directory until it stops.",
		);
	}
	console.log(`- Record: ${session.file}`);
	console.log(`- Native resume: ${resumeLine(session)}${session.resume.command ? `. ${session.resume.note}` : ""}`);
	if (result.latestSummary)
		console.log(`\n## Latest compaction summary (of ${result.summaryCount})\n\n${result.latestSummary}`);
	const files = result.filesEdited;
	if (files.length) {
		console.log(`\n## Files edited (${files.length})\n`);
		for (const file of files.slice(0, 60)) console.log(`- ${file}`);
		if (files.length > 60) console.log(`- … ${files.length - 60} more (--json lists all)`);
	}
	console.log(`\n## Last ${result.turns.length} of ${result.totalTurns} turns`);
	for (const turn of result.turns) {
		console.log(`\n### Turn ${turn.turn}\n\nUser: ${turn.user || "(no prompt: continued from before)"}`);
		if (turn.assistant) console.log(`\nAssistant: ${turn.assistant}`);
		if (turn.tools.length) {
			const shown = turn.tools.slice(0, 15).map((tool) => `  - ${tool}`);
			const more = turn.tools.length > 15 ? `\n  - … ${turn.tools.length - 15} more` : "";
			console.log(`\nTools (${turn.tools.length}):\n${shown.join("\n")}${more}`);
		}
	}
	if (result.lastAssistantMessage) console.log(`\n## Last assistant message\n\n${result.lastAssistantMessage}`);
}

export function printWorktrees(ctx, trees, base) {
	console.log(`Worktrees of ${ctx.root} (compared with ${base ?? "no base branch"}): ${trees.length}`);
	for (const tree of trees) {
		const head = tree.branch ?? (tree.head ? `detached ${tree.head.slice(0, 12)}` : "no HEAD");
		const changes =
			tree.changedFiles === undefined ? "" : tree.changedFiles ? `, ${tree.changedFiles} changed files` : ", clean";
		const counts = tree.ahead === undefined ? "" : `, ${tree.ahead} ahead / ${tree.behind} behind`;
		const last = tree.lastCommitAt ? `, last commit ${ago(tree.lastCommitAt)}` : "";
		console.log(`\n${tree.kind}: ${tree.path}${tree.missing ? " (folder missing)" : ""}`);
		console.log(`  ${head}${changes}${counts}${last}`);
		if (tree.advice.state !== "root") console.log(`  ${tree.advice.state}: ${tree.advice.action}`);
		const sessions = tree.sessions ?? [];
		if (sessions.length) {
			console.log(`  sessions (${sessions.length}):`);
			for (const s of sessions.slice(0, 5)) {
				const t = timing(s);
				console.log(`    ${s.harness}:${s.id} ${t.idle}${t.live ? " LIVE?" : ""} - ${oneLine(s.title, 80)}`);
			}
		}
	}
}

export function printLocations(ctx, rows) {
	console.log(`Where sessions for ${ctx.root} are looked up:`);
	for (const row of rows)
		console.log(
			`${row.exists ? "found  " : "absent "} ${row.label}: ${row.path}${row.detail ? ` (${row.detail})` : ""}`,
		);
	console.log(`\nScopes: sessions count when their directory is in one of these:`);
	for (const scope of ctx.scopes)
		console.log(`  ${scope.kind}: ${scope.path}${scope.missing ? " (folder missing)" : ""}`);
}
