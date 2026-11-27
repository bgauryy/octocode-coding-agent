import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { excludeLiveTests, LIVE_TESTS_ENV } from "../../vitest.live.ts";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));

// A live run (`yarn test:live`) reaches real providers, so the offline fetch guard stays off for it.
const live = process.env[LIVE_TESTS_ENV] === "1";

export default defineConfig({
	test: {
		exclude: excludeLiveTests(),
		globalSetup: [fileURLToPath(new URL("../../vitest.tmp.global.ts", import.meta.url))],
		globals: true,
		environment: "node",
		setupFiles: live ? ["./test/setup-cache-env.ts"] : ["./test/setup-cache-env.ts", "./test/setup/no-network.ts"],
		testTimeout: 30000, // 30 seconds for API calls
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [{ find: /^@octocodeai\/octocode-telemetry$/, replacement: telemetrySrcIndex }],
	},
});
