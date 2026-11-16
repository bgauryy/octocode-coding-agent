import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Cassettes and the cache report land in the repository's untracked tmp directory unless the caller chose one.
process.env.TESTKIT_REPORT_DIR ??= resolve(import.meta.dirname, "../../.octocode/tmp");

// det-loopback tier: real clock (loopback sockets and child processes stall under fake timers),
// no external network: the gateway is scripted unless a test opts into Ollama.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["./src/setup.ts"],
		globalSetup: ["./src/cache-report.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
		pool: "forks",
	},
});
