import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			include: ["test/**/*.test.ts"],
			setupFiles: [fileURLToPath(new URL("../coding-agent/test/octocode/setup-env.ts", import.meta.url))],
			testTimeout: 30000,
			hookTimeout: 30000,
			maxWorkers: 4,
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
		},
	}),
);
