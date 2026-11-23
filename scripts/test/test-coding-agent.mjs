#!/usr/bin/env node
import { runTestSuites } from "./run-test-suites.mjs";

const args = process.argv.slice(2);
process.exitCode = await runTestSuites([
	{ label: "coding-agent core", args: ["exec", "vitest", "--run", ...args] },
	{
		label: "coding-agent native",
		args: ["exec", "vitest", "--run", "--config", "vitest.octocode.config.ts", ...args],
	},
	{ label: "coding-agent e2e", args: ["run", "test:e2e", ...args] },
]);
