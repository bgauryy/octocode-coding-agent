import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const codingAgentTest = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8")).scripts
	.test;
const workerSource = `
const { appendFileSync } = require("node:fs");
appendFileSync(process.argv[1], JSON.stringify({ label: "worker", pid: process.pid }) + "\\n");
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
setInterval(() => {}, 1000);
`;
const fakeYarn = `
const { appendFileSync, readFileSync } = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { resolve, join } = require("node:path");
const root = resolve(__dirname, "../..");
const log = join(root, "events.jsonl");
const config = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
const args = process.argv.slice(2);
function record(label, extra = {}) {
  appendFileSync(log, JSON.stringify({ label, args, pid: process.pid, cwd: process.cwd(),
    home: process.env.HOME, tmp: process.env.TMPDIR, secret: process.env.TEST_SECRET,
    xdg: process.env.XDG_CONFIG_HOME, npm: process.env.NPM_CONFIG_USERCONFIG,
    localLlm: process.env.OCTOCODE_NO_LOCAL_LLM, ...extra }) + "\\n");
}
if (args[0] === "workspaces") {
  record("discovery");
  for (const row of [
    { name: "@octocodeai/octocode-monorepo", location: "." },
    { name: "@octocodeai/octocodecode", location: "packages/coding-agent" },
    { name: "tail", location: "packages/tail" },
    { name: "no-tests", location: "packages/no-tests" }
  ]) console.log(JSON.stringify(row));
  process.exit(config.discoveryFailure ?? 0);
}
if (args[0] === "workspace" && args[1] === "@octocodeai/octocodecode") {
  record("coding-agent");
  const result = spawnSync(process.execPath, [join(root, "scripts/test-coding-agent.mjs"), ...args.slice(4)],
    { cwd: join(root, "packages/coding-agent"), stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const label = args[0] === "workspace" ? "tail" : args[1] === "test:scripts" ? "scripts" :
  args[1] === "test:e2e" ? "e2e" : args.includes("--config") ? "native" : "core";
record(label);
if (config.signalStage === label) process.kill(process.pid, config.signal);
else if (config.blockStage === label) {
  const worker = spawn(process.execPath, ["-e", ${JSON.stringify(workerSource)}, log], { stdio: "ignore" });
  worker.unref();
  if (config.ignoreSignals) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {});
  } else {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(0));
  }
  setInterval(() => {}, 1000);
} else process.exit(config.failures?.[label] ?? 0);
`;

function fixture(t, settings = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "test runners # ")));
	const write = (path, content) => {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	};
	for (const path of [
		"test.sh",
		"scripts/test-workspaces.mjs",
		"scripts/test-coding-agent.mjs",
		"scripts/run-test-suites.mjs",
		"scripts/yarn-command.mjs",
	]) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		copyFileSync(join(repoRoot, path), join(root, path));
	}
	write("package.json", JSON.stringify({ name: "@octocodeai/octocode-monorepo", type: "module" }));
	write("packages/coding-agent/package.json", JSON.stringify({ scripts: { test: codingAgentTest } }));
	write("packages/tail/package.json", JSON.stringify({ scripts: { test: "unused" } }));
	write("packages/no-tests/package.json", "{}");
	write(".yarnrc.yml", "yarnPath: .yarn/releases/pinned.cjs\n");
	write(".yarn/releases/pinned.cjs", fakeYarn);
	write("settings.json", JSON.stringify(settings));
	write("events.jsonl", "");
	write("bin/yarn", "#!/bin/sh\necho 'Global Yarn must not run' >&2\nexit 98\n");
	chmodSync(join(root, "bin/yarn"), 0o755);
	mkdirSync(join(root, "temp parent"));
	const events = () =>
		readFileSync(join(root, "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	t.after(() => {
		for (const { pid } of events()) {
			try {
				process.kill(pid, "SIGKILL");
			} catch (error) {
				if (error.code !== "ESRCH") throw error;
			}
		}
		rmSync(root, { recursive: true, force: true });
	});
	return { root, events };
}

function run(root, entry, args = []) {
	const launcher = entry === "test.sh";
	return spawnSync(launcher ? "bash" : process.execPath, [join(root, entry), ...args], {
		cwd: launcher ? tmpdir() : join(root, "packages/coding-agent"),
		env: {
			...process.env,
			OCTOCODE_TEST_SUITE_CHILD: "",
			PATH: `${join(root, "bin")}:${process.env.PATH}`,
			TMPDIR: join(root, "temp parent"),
			TEST_SECRET: "must-be-removed",
		},
		encoding: "utf8",
		timeout: 10000,
	});
}

test("isolated launcher uses pinned Yarn, preserves literal arguments and runs every failing stage and workspace", (t) => {
	const { root, events } = fixture(t, { failures: { scripts: 7, core: 2, native: 3, e2e: 4 } });
	const args = ["--filter", "path with spaces", "$(must-stay-literal);*"];
	const result = run(root, "test.sh", args);
	assert.equal(result.status, 1, result.stderr);
	const rows = events();
	assert.deepEqual(
		rows.map(({ label }) => label),
		["discovery", "scripts", "coding-agent", "core", "native", "e2e", "tail"],
	);
	for (const row of rows) {
		assert.equal(row.secret, undefined);
		assert.equal(row.localLlm, "1");
		assert.equal(row.xdg, join(row.home, ".config"));
		assert.equal(row.npm, join(dirname(row.home), "npm-userconfig"));
		assert.equal(existsSync(dirname(row.home)), false, "launcher removed its owned isolation directory");
		if (row.label !== "discovery") assert.deepEqual(row.args.slice(-args.length), args);
	}
	assert.match(result.stderr, /Failed: coding-agent core, coding-agent native, coding-agent e2e/);
	assert.match(result.stderr, /Failed: scripts, @octocodeai\/octocodecode/);
	assert.equal(rows[0].cwd, root);
	assert.equal(rows.find(({ label }) => label === "core").cwd, join(root, "packages/coding-agent"));
});

test("coding-agent package test runs all three stages and reports success only when all pass", (t) => {
	const { root, events } = fixture(t);
	const command = codingAgentTest.split(" ");
	assert.deepEqual(command, ["node", "../../scripts/test-coding-agent.mjs"]);
	const result = run(root, "scripts/test-coding-agent.mjs");
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		events().map(({ args }) => args),
		[
			["exec", "vitest", "--run"],
			["exec", "vitest", "--run", "--config", "vitest.octocode.config.ts"],
			["run", "test:e2e"],
		],
	);
	assert.match(result.stdout, /3\/3 test suites passed/);
});

test("a native failure still runs e2e and preserves the combined failure status", (t) => {
	const { root, events } = fixture(t, { failures: { native: 5 } });
	const result = run(root, "scripts/test-coding-agent.mjs");
	assert.equal(result.status, 1, result.stderr);
	assert.deepEqual(
		events().map(({ label }) => label),
		["core", "native", "e2e"],
	);
	assert.match(result.stdout, /2\/3 test suites passed/);
	assert.match(result.stderr, /Failed: coding-agent native/);
});

test("discovery failure returns nonzero and cleans the isolated home without starting suites", (t) => {
	const { root, events } = fixture(t, { discoveryFailure: 9 });
	const result = run(root, "test.sh");
	assert.notEqual(result.status, 0);
	assert.deepEqual(
		events().map(({ label }) => label),
		["discovery"],
	);
	assert.equal(existsSync(dirname(events()[0].home)), false);
});

for (const [signal, status] of [
	["SIGINT", 130],
	["SIGTERM", 143],
]) {
	test(`a suite terminated by ${signal} cancels later stages and workspaces`, (t) => {
		const { root, events } = fixture(t, { signalStage: "scripts", signal });
		const result = run(root, "test.sh");
		assert.equal(result.status, status, result.stderr);
		assert.deepEqual(
			events().map(({ label }) => label),
			["discovery", "scripts"],
		);
		assert.match(result.stderr, new RegExp(`Cancelled: ${signal}`));
		assert.equal(existsSync(dirname(events()[0].home)), false);
	});
}

test("Yarn's numeric cancellation status stops subsequent coding-agent stages", (t) => {
	const { root, events } = fixture(t, { failures: { core: 130 } });
	const result = run(root, "scripts/test-coding-agent.mjs");
	assert.equal(result.status, 130, result.stderr);
	assert.deepEqual(
		events().map(({ label }) => label),
		["core"],
	);
	assert.match(result.stderr, /Cancelled: SIGINT/);
});

async function waitFor(predicate) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await delay(25);
	}
	assert.fail("Timed out waiting for fixture process");
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

for (const [entry, blockStage, signal, status, ignoreSignals] of [
	["test.sh", "scripts", "SIGTERM", 143, false],
	["test.sh", "core", "SIGINT", 130, false],
	["scripts/test-coding-agent.mjs", "core", "SIGTERM", 143, true],
]) {
	test(
		`${entry} forwards ${signal} and reaps descendants (ignore signals: ${ignoreSignals})`,
		{
			skip: process.platform === "win32",
			timeout: 12000,
		},
		async (t) => {
			const { root, events } = fixture(t, { blockStage, ignoreSignals });
			const launcher = entry === "test.sh";
			const child = spawn(launcher ? "bash" : process.execPath, [join(root, entry)], {
				cwd: launcher ? tmpdir() : join(root, "packages/coding-agent"),
				env: { ...process.env, OCTOCODE_TEST_SUITE_CHILD: "", TMPDIR: join(root, "temp parent") },
				stdio: ["ignore", "pipe", "pipe"],
			});
			t.after(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			});
			let stderr = "";
			child.stdout.resume();
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			const closed = once(child, "close");
			await waitFor(() => events().some(({ label }) => label === "worker"));
			child.kill(signal);
			const [code] = await closed;
			assert.equal(code, status, stderr);
			const rows = events();
			assert.equal(
				rows.some(({ label }) => ["native", "e2e", "tail"].includes(label)),
				false,
			);
			for (const { pid } of rows) await waitFor(() => !alive(pid));
			if (launcher) assert.equal(existsSync(dirname(rows[0].home)), false);
		},
	);
}
