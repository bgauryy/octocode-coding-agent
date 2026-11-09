import os from "node:os";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

/**
 * Scripted-model end-to-end suites (`test/octocode/e2e*.test.ts`): a real session, the real Octocode extension and the
 * Octocode MCP server, with a faux model in place of a provider. They need the sibling Octocode MCP build but no network
 * or credentials, and `vitest.octocode.config.ts` leaves them out because each file starts a full runtime.
 * Run with `yarn test:e2e`.
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			include: ["test/octocode/e2e*.test.ts"],
			setupFiles: ["test/octocode/setup-env.ts"],
			globalSetup: ["test/home-guard.global.ts", "test/octocode/mcp-preflight.global.ts"],
			testTimeout: 60000,
			hookTimeout: 60000,
			// Each test boots real processes from source, so the suite is bound by CPU: a third of the cores, 2 to 4 workers.
			maxWorkers: Math.max(2, Math.min(4, Math.floor(os.availableParallelism() / 3))),
		},
	}),
);
