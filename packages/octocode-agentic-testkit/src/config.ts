import { fileURLToPath } from "node:url";
import type { InlineConfig } from "vitest/node";
import AgentReporter from "./reporter.ts";

/** Per-test and per-hook timeout: one agent turn on a real model can take tens of seconds. */
const TIMEOUT_MS = 60_000;

// This module runs as `config.ts` from source and as `config.js` from `dist`; its siblings share that extension.
const EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const sibling = (name: string): string => fileURLToPath(new URL(`./${name}${EXT}`, import.meta.url));

type Reporter = Extract<NonNullable<InlineConfig["reporters"]>, unknown[]>[number];
const files = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
// A top-level array is a list of reporters; a `[name, options]` pair only appears inside such a list.
const reporterList = (v: InlineConfig["reporters"]): Reporter[] =>
	v === undefined ? ["default"] : Array.isArray(v) ? v : [v];

/**
 * The Vitest `test` options the kit needs: the setup file that registers the matchers, the run-cache global setup,
 * the `forks` pool (agent harnesses are child processes and loopback servers), real-time test and hook timeouts and
 * `AgentReporter` after your reporters (`default` when you set none). Your `setupFiles`, `globalSetup` and
 * `reporters` are appended to the kit's; every other option you pass replaces the kit's value.
 *
 * `defineConfig({ test: testkitConfig({ testTimeout: 120_000 }) })`
 */
export function testkitConfig(overrides: InlineConfig = {}): InlineConfig {
	const { setupFiles, globalSetup, reporters, ...rest } = overrides;
	return {
		pool: "forks",
		testTimeout: TIMEOUT_MS,
		hookTimeout: TIMEOUT_MS,
		...rest,
		setupFiles: [sibling("setup"), ...files(setupFiles)],
		globalSetup: [sibling("cache-report"), ...files(globalSetup)],
		reporters: [...reporterList(reporters), new AgentReporter()],
	};
}
