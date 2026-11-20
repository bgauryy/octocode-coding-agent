#!/usr/bin/env node
// `build:offline`: the workspace builds and the agent-prompt generation run side by side. The prompt generator reads
// source through the source resolver (`packages/coding-agent/scripts/source-resolver.ts`), never dist, and no build reads
// what it writes (`copy-native.mjs` skips `prompts/final/`), so it needs no finished build. Each step's output is buffered
// and printed whole when it ends, so the two do not interleave. Exits non-zero when either step fails.
import { spawn } from "node:child_process";

const steps = [
	{
		name: "workspaces",
		args: [
			"workspaces",
			"foreach",
			"--all",
			"--topological-dev",
			"--parallel",
			"--exclude",
			"@octocodeai/octocode-monorepo",
			"run",
			"build",
		],
	},
	{ name: "prompts", args: ["workspace", "@octocodeai/octocode-agent", "run", "generate:prompts", "--fail-open"] },
];

function run({ name, args }) {
	const started = performance.now();
	return new Promise((resolve) => {
		const child = spawn("yarn", args, { stdio: ["ignore", "pipe", "pipe"] });
		const chunks = [];
		child.stdout.on("data", (chunk) => chunks.push(chunk));
		child.stderr.on("data", (chunk) => chunks.push(chunk));
		const done = (code) =>
			resolve({ name, code, seconds: (performance.now() - started) / 1000, output: Buffer.concat(chunks) });
		// A spawn failure (no yarn on PATH) is reported as the step's output and fails the build.
		child.on("error", (error) => {
			chunks.push(Buffer.from(`${error.message}\n`));
			done(1);
		});
		child.on("close", (code) => done(code ?? 1));
	});
}

const results = await Promise.all(steps.map(run));
for (const { name, code, seconds, output } of results) {
	process.stdout.write(`\n== ${name} (exit ${code}, ${seconds.toFixed(1)}s) ==\n`);
	process.stdout.write(output);
}
process.exitCode = results.some((result) => result.code !== 0) ? 1 : 0;
