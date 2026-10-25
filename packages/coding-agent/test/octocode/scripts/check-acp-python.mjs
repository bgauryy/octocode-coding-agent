import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		python: { type: "string" },
		report: { type: "string" },
		help: { type: "boolean" },
	},
});
if (values.help) {
	console.log(`Check both ACP directions with Python agent-client-protocol==0.12.1.
  yarn node test/octocode/scripts/check-acp-python.mjs --python /venv/bin/python [--report /path/report.json]
Requires Node 24.15+ within Node 24 and workspace dependencies. Install the Python
package in a separate environment first. Uses offline fixtures and isolated user
configuration; no provider calls. This is an interoperability check, not certification.`);
} else {
	await main();
}

function recordedProcesses(journal) {
	if (!existsSync(journal)) return [];
	const records = readFileSync(journal, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	for (const record of records) {
		assert(["broker", "worker", "peer"].includes(record.kind));
		assert(Number.isSafeInteger(record.pid) && record.pid > 0);
	}
	return [...new Map(records.map((record) => [record.pid, record])).values()];
}

async function main() {
	assert(values.python, "Provide --python pointing to an environment with agent-client-protocol==0.12.1.");
	const [major, minor] = process.versions.node.split(".").map(Number);
	assert(major === 24 && minor >= 15, "Use Node 24.15+ within Node 24.");
	const python = resolve(values.python);
	const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
	const root = resolve(packageDir, "../..");
	const reportPath = resolve(values.report ?? join(root, ".octocode/octocode-research/tmp/acp-python/report.json"));
	const temporary = mkdtempSync(join(tmpdir(), "octocode-acp-python-run-"));
	const children = [];
	const stop = new AbortController();
	const interrupt = () => stop.abort(new Error("Interrupted"));
	const report = { startedAt: new Date().toISOString(), node: process.version, pythonSdk: "0.12.1", outbound: [] };
	let runtime;
	let journal;
	let failure;
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupt);
	try {
		const run = realpathSync(temporary);
		journal = join(run, "processes.jsonl");
		const env = {
			PATH: process.env.PATH,
			...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
			HOME: run,
			USERPROFILE: run,
			TMPDIR: tmpdir(),
			OCTOCODE_HOME: join(run, "home"),
			OCTOCODE_CODING_AGENT_DIR: join(run, "home"),
			PI_CODING_AGENT_DIR: join(run, "pi"),
			OCTOCODE_AGENT_DB: join(run, "agent.sqlite"),
			OCTOCODE_ACP_FIXTURE_RUN: run,
			OCTOCODE_ACP_FIXTURE_PIDS: journal,
			OCTOCODE_OFFLINE: "1",
			OCTOCODE_MCP: "0",
			OCTOCODE_MODELS_DEV: "0",
			OCTOCODE_API: "0",
			OCTOCODE_MEMORY_AUTO: "0",
			OCTOCODE_NOTIFY: "off",
			OCTOCODE_TELEMETRY: "0",
		};
		const config = join(run, "launch.json");
		const resolver = join(packageDir, "scripts/source-resolver.ts");
		const peer = join(packageDir, "test/fixtures/acp-python-peer.py");
		writeFileSync(
			config,
			JSON.stringify({
				cwd: run,
				env,
				python,
				packageDir,
				resolver,
				peer,
				command: [
					process.execPath,
					"--import",
					resolver,
					join(packageDir, "src/cli.ts"),
					"--mode",
					"acp",
					"--no-builtin-tools",
					"--no-extensions",
					"--extension",
					join(packageDir, "test/fixtures/acp-compatibility-provider.ts"),
					"--no-skills",
					"--no-context-files",
					"--offline",
					"--provider",
					"acp-compatibility-fixture",
					"--model",
					"fixture",
				],
			}),
			{ mode: 0o600 },
		);
		await import(resolver);
		runtime = await import(join(packageDir, "src/octocode/shared/process.ts"));
		const { untilAborted } = await import(join(packageDir, "src/octocode/shared/util.ts"));
		const runChild = async (command, args) => {
			await runtime.prepareTree();
			stop.signal.throwIfAborted();
			const child = spawn(command, args, {
				cwd: run,
				env,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(child);
			runtime.adoptTree(child.pid);
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (text) => {
				stdout = (stdout + text).slice(-65_536);
			});
			child.stderr.setEncoding("utf8").on("data", (text) => {
				stderr = (stderr + text).slice(-65_536);
			});
			const [code] = await untilAborted(
				once(child, "close"),
				AbortSignal.any([stop.signal, AbortSignal.timeout(110_000)]),
			);
			assert.equal(code, 0, stderr);
			return JSON.parse(stdout.trim());
		};
		report.inbound = await runChild(python, [peer, "client", config]);
		const workers = recordedProcesses(journal).filter((record) => record.kind === "worker");
		assert(workers.length >= 4, "Missing PID evidence for created/restored native workers.");
		report.nativeWorkersStoppedBeforeFallback = workers.every(({ pid }) => !runtime.processAlive(pid));
		assert(report.nativeWorkersStoppedBeforeFallback, "Native workers survived their session and broker closure.");
		const outbound = await runChild(process.execPath, [
			join(packageDir, "test/octocode/scripts/acp-python-outbound.mjs"),
			config,
		]);
		report.outbound = outbound.checks;
		report.outboundCleanup = outbound;
		assert.equal(report.inbound.checks.length + report.outbound.length, 11);
	} catch (error) {
		failure = error;
		report.error = error instanceof Error ? error.stack : String(error);
	} finally {
		const cleanupErrors = [];
		let known = [];
		try {
			known = journal ? recordedProcesses(journal) : [];
			if (runtime) {
				report.processesBeforeFallback = known.map((record) => ({
					...record,
					stopped: !runtime.processAlive(record.pid),
				}));
				const pids = new Set([...children.map((child) => child.pid), ...known.map((record) => record.pid)]);
				const stopped = await Promise.allSettled(
					[...pids].filter((pid) => runtime.processAlive(pid)).map((pid) => runtime.stopTree(pid)),
				);
				for (const result of stopped) if (result.status === "rejected") cleanupErrors.push(String(result.reason));
				report.cleanup = {
					knownProcessesStopped: known.every(({ pid }) => !runtime.processAlive(pid)),
					clientsStopped: children.every((child) => !runtime.processAlive(child.pid)),
				};
			}
		} catch (error) {
			cleanupErrors.push(String(error));
		} finally {
			for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupt);
			try {
				rmSync(temporary, { recursive: true, force: true });
			} catch (error) {
				cleanupErrors.push(String(error));
			}
		}
		report.temporaryRemoved = !existsSync(temporary);
		if (cleanupErrors.length) report.cleanupErrors = cleanupErrors;
		report.finishedAt = new Date().toISOString();
		mkdirSync(dirname(reportPath), { recursive: true });
		writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`ACP Python interoperability report: ${reportPath}`);
	}
	if (failure) throw failure;
	assert(!report.cleanupErrors && report.temporaryRemoved, "Interoperability fixture cleanup failed.");
	assert(
		report.processesBeforeFallback.every((record) => record.stopped),
		"Interoperability processes survived their owner cleanup.",
	);
	assert(Object.values(report.cleanup).every(Boolean), "Interoperability process cleanup failed.");
}
