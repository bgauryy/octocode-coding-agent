import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globalSetup: [fileURLToPath(new URL("../../vitest.tmp.global.ts", import.meta.url))],
		globals: true,
		environment: "node",
		setupFiles: ["./test/setup-cache-env.ts"],
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [{ find: /^@octocodeai\/octocode-telemetry$/, replacement: telemetrySrcIndex }],
	},
});
