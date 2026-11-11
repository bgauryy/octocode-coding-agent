import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			include: ["test/**/*.test.ts"],
			// The shell tests start real zsh, bash, fish or PowerShell processes when they are installed.
			testTimeout: 30000,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		},
	}),
);
