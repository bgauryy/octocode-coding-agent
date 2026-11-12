#!/usr/bin/env node
/**
 * Runs a coding agent CLI (Claude Code, Codex, Octocode) against the local mock (`mock.mjs`) and keeps every request it
 * sends: the exact prompt, tools and parameters, without a model call, a cost or a credential. The client gets a fresh
 * home seeded for the mock, a fresh Git working folder, and a dead proxy for every other host.
 *
 *   node scripts/agent-capture/capture.mjs [options] <scenario> -- <command...>
 *
 * Options: `--out <dir>` (default `.octocode/tmp/agent-capture/<scenario>`, which Git ignores), `--work <dir>` (the
 * client's working folder; default a fresh repository in the output), `--tool` (the first answer is one shell call),
 * `--pty <steps.json>` (drive an interactive client through `pty-drive.py` and record its terminal bytes),
 * `--dead-proxy-port <n>` (default 9). Writes `requests/NNN.json`, `stdout.txt`, `terminal.raw` with `--pty`, then prints
 * the size of each request (`request-size.mjs`).
 */

import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startMock } from "./mock.mjs";
import { formatSizes, measureRequest, requestFiles } from "./request-size.mjs";

const KIT = import.meta.dirname;
const REPO = resolve(KIT, "..", "..");
const PASSED_THROUGH = [
	"PATH",
	"TERM",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"COLORTERM",
];

/** Whether something accepts TCP connections on `port` at 127.0.0.1. A dropped or refused attempt is false. */
function portListens(port) {
	return new Promise((done) => {
		const socket = connect({ host: "127.0.0.1", port });
		const finish = (listening) => {
			socket.destroy();
			done(listening);
		};
		socket.setTimeout(1_000, () => finish(false));
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

/** Why `dir` may not hold raw captures (it lies in this repository and Git does not ignore it), or undefined. */
export function trackedOutputReason(dir, repo = REPO) {
	const inside = relative(repo, resolve(dir));
	if (inside.startsWith("..") || isAbsolute(inside)) return undefined;
	const ignored = spawnSync("git", ["-C", repo, "check-ignore", "-q", "--no-index", inside || "."]).status === 0;
	return ignored ? undefined : `${dir} is inside the repository and not ignored by Git: raw captures stay out of it`;
}

/**
 * The client's whole environment: the terminal and locale of this one, and nothing else of it (no real key, home or
 * proxy), the mock's endpoints with dummy keys, and a dead proxy for every other host.
 */
export function captureEnv(base, { home, port, proxyPort }) {
	const env = Object.fromEntries(
		PASSED_THROUGH.filter((key) => base[key] !== undefined).map((key) => [key, base[key]]),
	);
	const proxy = `http://127.0.0.1:${proxyPort}`;
	const mock = `http://127.0.0.1:${port}`;
	return {
		...env,
		HOME: home,
		CODEX_HOME: join(home, ".codex"),
		ANTHROPIC_BASE_URL: mock,
		ANTHROPIC_API_KEY: "sk-ant-mock",
		OPENAI_BASE_URL: `${mock}/v1`,
		OPENAI_API_KEY: "sk-mock",
		CODEX_API_KEY: "sk-mock",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_AUTOUPDATER: "1",
		// Node's own fetch honors the proxy variables only with this set (Octocode runs on Node).
		NODE_USE_ENV_PROXY: "1",
		...Object.fromEntries(
			["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"].flatMap((key) => [
				[key, proxy],
				[key.toLowerCase(), proxy],
			]),
		),
		NO_PROXY: "127.0.0.1,localhost",
		no_proxy: "127.0.0.1,localhost",
	};
}

/**
 * Seeds `home` so each client starts without onboarding, trusts `work` and talks to the mock: Claude Code accepts the
 * dummy key; Codex needs its own provider (it ignores `OPENAI_BASE_URL`), without websockets; Octocode gets a
 * `models.json` that moves its built-in `anthropic` provider to the mock (run it with
 * `--model anthropic/<id> --trust`).
 */
function seedHome(home, { port, work }) {
	const folders = [...new Set([work, realpathSync(work)])];
	mkdirSync(join(home, ".codex"), { recursive: true });
	mkdirSync(join(home, ".octocode", "agent"), { recursive: true });
	const trusted = Object.fromEntries(
		folders.map((folder) => [folder, { hasTrustDialogAccepted: true, allowedTools: [] }]),
	);
	writeFileSync(
		join(home, ".claude.json"),
		`${JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", numStartups: 5, customApiKeyResponses: { approved: ["sk-ant-mock"], rejected: [] }, projects: trusted }, null, 1)}\n`,
	);
	writeFileSync(
		join(home, ".codex", "config.toml"),
		[
			'model_provider = "mock"',
			'model = "gpt-6-sol"',
			'model_reasoning_effort = "medium"',
			"",
			"[model_providers.mock]",
			'name = "mock"',
			`base_url = "http://127.0.0.1:${port}/v1"`,
			'wire_api = "responses"',
			'env_key = "OPENAI_API_KEY"',
			"supports_websockets = false",
			...folders.flatMap((folder) => ["", `[projects.${JSON.stringify(folder)}]`, 'trust_level = "trusted"']),
			"",
			"[tui]",
			"screen_reader_detection_done = true",
			"",
		].join("\n"),
	);
	// The built-in `anthropic` provider keeps its models and request compatibility with only its host moved to the mock
	// (its key is the dummy `ANTHROPIC_API_KEY`). The mock stands in for Anthropic's own API, which takes the 1-hour cache
	// tier that Octocode grants only by host: the compat flag restores it.
	writeFileSync(
		join(home, ".octocode", "agent", "models.json"),
		`${JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${port}`, compat: { supportsLongCacheRetention: true } } } }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
}

/** A fresh repository with one commit, so clients that read Git state see a normal project. */
function seedWork(work) {
	mkdirSync(work, { recursive: true });
	if (existsSync(join(work, ".git"))) return;
	writeFileSync(join(work, "README.md"), "# demo\n");
	const git = (...args) =>
		spawnSync("git", ["-C", work, "-c", "user.email=capture@example.invalid", "-c", "user.name=capture", ...args]);
	git("init", "-q");
	git("add", "README.md");
	git("commit", "-qm", "init");
}

function run(command, { cwd, env, log }) {
	const out = openSync(log, "w");
	return new Promise((done) => {
		const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["ignore", out, out] });
		child.once("error", (error) => {
			appendFileSync(log, `${error.message}\n`);
			done(127);
		});
		child.once("exit", (code, signal) => done(code ?? (signal ? 128 : 1)));
	});
}

async function main() {
	const separator = process.argv.indexOf("--");
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2, separator < 0 ? undefined : separator),
		options: {
			out: { type: "string" },
			work: { type: "string" },
			tool: { type: "boolean" },
			pty: { type: "string" },
			"dead-proxy-port": { type: "string", default: "9" },
		},
		allowPositionals: true,
	});
	const command = separator < 0 ? [] : process.argv.slice(separator + 1);
	const [scenario] = positionals;
	if (!scenario || command.length === 0) {
		console.error(
			"Usage: capture.mjs [--out <dir>] [--work <dir>] [--tool] [--pty <steps.json>] <scenario> -- <command...>",
		);
		return 2;
	}
	const out = resolve(values.out ?? join(REPO, ".octocode", "tmp", "agent-capture", scenario));
	const proxyPort = Number(values["dead-proxy-port"]);
	const tracked = trackedOutputReason(out);
	if (tracked) {
		console.error(`Refused: ${tracked}.`);
		return 2;
	}
	// The dead proxy is what keeps a client off the network: refuse when something answers on it.
	if (!Number.isInteger(proxyPort) || proxyPort <= 0 || (await portListens(proxyPort))) {
		console.error(`Refused: 127.0.0.1:${values["dead-proxy-port"]} must be a closed port to serve as the dead proxy.`);
		return 2;
	}
	rmSync(out, { recursive: true, force: true });
	const work = resolve(values.work ?? join(out, "work"));
	seedWork(work);
	const requests = join(out, "requests");
	const mock = await startMock({ dir: requests, tool: values.tool === true });
	const home = join(out, "home");
	seedHome(home, { port: mock.port, work });
	const argv = values.pty
		? ["python3", join(KIT, "pty-drive.py"), join(out, "terminal.raw"), resolve(values.pty), "--", ...command]
		: command;
	const log = join(out, "stdout.txt");
	const code = await run(argv, { cwd: work, env: captureEnv(process.env, { home, port: mock.port, proxyPort }), log });
	appendFileSync(log, `exit ${code}\n`);
	await mock.close();
	const rows = existsSync(requests)
		? requestFiles(requests).map(({ label, file }) => ({
				label,
				size: measureRequest(JSON.parse(readFileSync(file, "utf8"))),
			}))
		: [];
	console.log(`${out}: ${rows.length} request(s), client exit ${code}`);
	if (rows.length > 0) console.log(formatSizes(rows));
	return code;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) process.exitCode = await main();
