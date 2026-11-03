import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			include: ["test/octocode/**/*.test.ts"],
			exclude: ["test/octocode/e2e*.test.ts", "test/octocode/*-chrome.test.ts"],
			setupFiles: ["test/octocode/setup-env.ts"],
			// Names the cause up front when the sibling Octocode MCP build cannot start; outcomes are unchanged.
			globalSetup: ["test/home-guard.global.ts", "test/octocode/mcp-preflight.global.ts"],
			testTimeout: 30000,
			hookTimeout: 30000,
			maxWorkers: 4,
			coverage: {
				// The host tests exercise the database workspace compiled into this package.
				allowExternal: true,
				include: ["src/octocode/**/*.ts", "src/config/{database,workspace,workspace-database}.ts", "../db/src/**/*.ts"],
				thresholds: { statements: 95.4, branches: 89, functions: 96.1, lines: 97.6 },
			},
		},
	}),
);
