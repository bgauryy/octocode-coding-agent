#!/usr/bin/env node
/**
 * Replays a recorded session through a real Octocode session, offline, and prints the report:
 *
 *   node scripts/replay-session.mjs <session.jsonl> [--out <report.md>] [--window <tokens>] [--profile] [--heap-prof]
 *
 * The replay is `packages/coding-agent/test/octocode/e2e-replay-local.test.ts`: each request gets the recorded reply and
 * each tool call the recorded result, in temporary folders with a temporary home and agent database. The session file is
 * only read (a copy is replayed). `--profile` writes a CPU profile of the replay (`--heap-prof`, a sampling heap profile
 * too) to `.octocode/tmp/replay-prof/` and adds its summary to the report. The report goes to
 * `.octocode/tmp/replay-<name>.md` unless `--out` says otherwise. A real session holds private content: keep its report
 * and profiles out of the repository.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profileMarkdown, summarizeProfile } from "./replay-profile.mjs";
import { spawnYarn } from "./yarn-command.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const positional = args.filter(
	(arg, index) => !arg.startsWith("--") && !["--out", "--window"].includes(args[index - 1]),
);
if (positional.length !== 1 || flag("--help")) {
	console.error(
		"Usage: node scripts/replay-session.mjs <session.jsonl> [--out <report.md>] [--window <tokens>] [--profile] [--heap-prof]",
	);
	process.exit(positional.length === 1 ? 0 : 2);
}
const source = resolve(positional[0]);
if (!existsSync(source)) {
	console.error(`No session file at ${source}`);
	process.exit(2);
}
const window = option("--window");
if (window !== undefined && !(Number(window) > 0)) {
	console.error(`--window takes a token count, not ${window}`);
	process.exit(2);
}
const name = basename(source, ".jsonl");
const out = resolve(option("--out") ?? join(root, ".octocode", "tmp", `replay-${name}.md`));
const profileDir = join(root, ".octocode", "tmp", "replay-prof");
const profile = flag("--profile") || flag("--heap-prof");

const env = {
	...process.env,
	OCTOCODE_TEST_REPLAY_SESSION: source,
	OCTOCODE_TEST_REPLAY_OUT: out,
	...(window ? { OCTOCODE_TEST_REPLAY_WINDOW: window } : {}),
	...(profile ? { OCTOCODE_TEST_REPLAY_PROFILE: profileDir } : {}),
	...(flag("--heap-prof") ? { OCTOCODE_TEST_REPLAY_HEAP: "1" } : {}),
};
const child = spawnYarn(
	["vitest", "run", "--config", "vitest.e2e.config.ts", "test/octocode/e2e-replay-local.test.ts"],
	{ cwd: join(root, "packages", "coding-agent"), env, stdio: "inherit" },
);
const code = await new Promise((done) => child.once("exit", (status) => done(status ?? 1)));
if (!existsSync(out)) {
	console.error(`The replay wrote no report (exit ${code}).`);
	process.exit(code || 1);
}
if (profile) {
	const cpu = join(profileDir, `${name}.cpuprofile`);
	if (existsSync(cpu))
		writeFileSync(out, `${readFileSync(out, "utf8")}\n${profileMarkdown(cpu, summarizeProfile(cpu))}`);
}
process.stdout.write(readFileSync(out, "utf8"));
console.error(`\nReport: ${out}`);
process.exit(code);
