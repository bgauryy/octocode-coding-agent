import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { excludeLiveTests } from "../../vitest.live.ts";
import { testkitConfig } from "./src/config.ts";

// Cassettes and the cache report land in the repository's untracked tmp directory unless the caller chose one.
process.env.TESTKIT_REPORT_DIR ??= resolve(import.meta.dirname, "../../.octocode/tmp");

// det-loopback tier: real clock (loopback sockets and child processes stall under fake timers),
// no external network: the gateway is scripted unless a test opts into Ollama.
// testkitConfig adds the matcher setup, the cache-report global setup, the forks pool, 60 s timeouts and the
// agent report (pass rates, spend, mock-tool coverage), which lands next to the cache report.
export default defineConfig({
	test: testkitConfig({ include: ["test/**/*.test.ts"], exclude: excludeLiveTests() }),
	// The examples import the package by name, as a consumer does; inside this package that resolves to `src`.
	resolve: {
		alias: [
			{ find: /^@octocodeai\/octocode-agentic-testkit$/, replacement: resolve(import.meta.dirname, "src/index.ts") },
		],
	},
});
