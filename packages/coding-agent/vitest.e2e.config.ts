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
			globalSetup: ["test/octocode/mcp-preflight.global.ts"],
			testTimeout: 60000,
			hookTimeout: 60000,
			maxWorkers: 2,
		},
	}),
);
