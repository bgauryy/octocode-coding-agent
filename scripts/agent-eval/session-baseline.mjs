#!/usr/bin/env node
/**
 * The baseline over stored sessions: cache read share per day and role, tool calls per tool per role, sessions that
 * start two or more children, output tokens spent on `reason`, reports whose first word is not an outcome word, and
 * first prompts replayed against stored memories. Offline and read-only: it opens the agent database and its transcript
 * mirror beside it (`transcripts.db`) read-only (no migration, no write), calls no model, and writes only when `--out`
 * names a file under `.octocode/tmp/`.
 *
 *   node scripts/agent-eval/session-baseline.mjs [--db <workspaces.db>] [--out .octocode/tmp/<file>.md] [--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentRuns, memories, openReadOnlyDb, transcripts } from "../../packages/db/src/api.ts";
import { transcriptDbPath } from "../../packages/coding-agent/src/storage/state-paths.ts";
import { renderBaseline } from "./lib/session-baseline-report.mjs";
import { sessionBaseline } from "./lib/session-baseline.mjs";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const TMP = path.join(REPO, ".octocode", "tmp");
/** The Octocode GitHub tools whose use per role decides which a profile keeps. */
const GITHUB_TOOLS = [
	"ghSearchCode",
	"ghGetFileContent",
	"ghStructure",
	"ghSearchRepo",
	"ghSearchHistory",
	"ghGetHistoryItem",
].map((name) => `mcp__octocode__${name}`);
/** The entry types the baseline reads: messages, and the custom entries that name a child's role. */
const ENTRY_TYPES = ["message", "custom"];
/** More runs than a retention window keeps. */
const ALL_RUNS = 1_000_000;

function defaultDatabase(env = process.env, home = os.homedir()) {
	return env.OCTOCODE_AGENT_DB ?? path.join(home, ".octocode", "octocodecode", "agent", "workspaces.db");
}

/** `file` when it lies under `.octocode/tmp/` of this checkout; the script writes nowhere else. */
export function outputPath(file, tmp = TMP) {
	const resolved = path.resolve(file);
	if (path.relative(tmp, resolved).startsWith("..") || path.isAbsolute(path.relative(tmp, resolved)))
		throw new Error(`--out must name a file under ${tmp}`);
	return resolved;
}

/**
 * Reads the rows through the database API on read-only connections (the coordination file and its transcript mirror)
 * and folds them into the baseline.
 */
export function readBaseline(file) {
	const db = openReadOnlyDb(file);
	const mirror = openReadOnlyDb(transcriptDbPath(file));
	try {
		return sessionBaseline({
			headers: transcripts.headers(mirror),
			entries: transcripts.scan(mirror, ENTRY_TYPES),
			runs: agentRuns.recent(db, { limit: ALL_RUNS }),
			memories: memories.texts(db),
		});
	} finally {
		mirror.close();
		db.close();
	}
}

function main(argv) {
	const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
	const file = value("--db") ?? defaultDatabase();
	if (!fs.existsSync(file)) throw new Error(`No agent database at ${file}`);
	const out = value("--out");
	const target = out === undefined ? undefined : outputPath(out);
	const baseline = readBaseline(file);
	const text = argv.includes("--json")
		? JSON.stringify(baseline, (_key, entry) => (entry instanceof Map ? Object.fromEntries(entry) : entry), 2)
		: renderBaseline(baseline, { source: file.replace(os.homedir(), "~"), githubTools: GITHUB_TOOLS });
	if (target) {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, text);
	}
	console.log(text);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
