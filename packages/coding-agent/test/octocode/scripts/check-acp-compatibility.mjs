#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const help = `Run the independent ACP v1 Test Compatibility Kit against the source CLI.

  yarn node test/octocode/scripts/check-acp-compatibility.mjs --tck /path/to/acp-tck
    [--report /path/to/report.json] [--match pytest-expression]

Requires Node 24.15+ within Node 24, installed workspace dependencies, uv, and an
acp-tck checkout with its locked dependencies available. Uses an offline fixture
provider and isolated user directories; it never uses provider credentials.
The TCK is experimental. Passing it is not official ACP certification.
`;

const argv = process.argv.slice(2);
if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
	console.log(help);
} else {
	try {
		await main(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

async function main(argv) {
	const flags = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!["--tck", "--report", "--match"].includes(flag) || !value || flags.has(flag))
			throw new Error(`Invalid or repeated option: ${flag}. Use --help.`);
		flags.set(flag, value);
	}
	if (!flags.has("--tck")) throw new Error("Provide the independent acp-tck checkout with --tck. Use --help.");
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major !== 24 || minor < 15) throw new Error("Use Node 24.15+ within the Node 24 line.");
	const tck = resolve(flags.get("--tck"));
	if (!existsSync(join(tck, "pyproject.toml")) || !existsSync(join(tck, "uv.lock")))
		throw new Error("--tck must name an acp-tck checkout containing pyproject.toml and uv.lock.");
	const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
	const root = resolve(packageDir, "../..");
	const report = resolve(flags.get("--report") ?? join(root, ".octocode/octocode-research/tmp/acp-tck/report.json"));
	mkdirSync(dirname(report), { recursive: true });
	const run = mkdtempSync(join(tmpdir(), "octocode-acp-tck-"));
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
		OCTOCODE_OFFLINE: "1",
		OCTOCODE_MCP: "0",
		OCTOCODE_MODELS_DEV: "0",
		OCTOCODE_API: "0",
		OCTOCODE_MEMORY_AUTO: "0",
		OCTOCODE_NOTIFY: "off",
		OCTOCODE_TELEMETRY: "0",
	};
	const args = [
		"--project",
		tck,
		"run",
		"--frozen",
		"acp-tck",
		"--protocol-version",
		"1",
		"--timeout",
		"30",
		"--startup-timeout",
		"45",
		"--test-timeout",
		"100",
		"--close-grace",
		"12",
		"--report-json",
		report,
		...(flags.has("--match") ? ["-k", flags.get("--match")] : []),
		"--",
		process.execPath,
		"--import",
		join(packageDir, "scripts/source-resolver.ts"),
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
	];
	try {
		const child = spawn("uv", args, { cwd: root, env, stdio: "inherit" });
		const signals = ["SIGINT", "SIGTERM"];
		const stop = (signal) => child.kill(signal);
		for (const signal of signals) process.on(signal, stop);
		try {
			process.exitCode = await new Promise((done, fail) => {
				child.once("error", fail);
				child.once("close", (code) => done(code ?? 1));
			});
		} finally {
			for (const signal of signals) process.off(signal, stop);
		}
		console.log(`ACP compatibility report: ${report}`);
	} finally {
		rmSync(run, { recursive: true, force: true });
	}
}
