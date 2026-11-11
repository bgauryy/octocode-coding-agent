import { defineConfig } from "vitest/config";

/**
 * A run started at the repository root goes through each package's own configuration, so its setup files point HOME and
 * OCTOCODE_HOME at temporary folders. Without this file Vitest would run a package test with no setup at all, against
 * the developer's real home.
 */
// Projects with their own worker limit run in their own group (Vitest requires one limit per group). The coding-agent
// package has three configurations under one package name, so the two extra ones also take their own project name.
const project = (dir: string, config: string, groupOrder: number, name?: string) => ({
	extends: `./packages/${dir}/${config}`,
	test: { ...(name ? { name } : {}), root: `./packages/${dir}`, sequence: { groupOrder } },
});

export default defineConfig({
	test: {
		projects: [
			"packages/*/vitest.config.ts",
			"!packages/acp/vitest.config.ts",
			project("acp", "vitest.config.ts", 1),
			project("coding-agent", "vitest.octocode.config.ts", 1, "octocodecode-native"),
			project("coding-agent", "vitest.e2e.config.ts", 2, "octocodecode-e2e"),
		],
	},
});
