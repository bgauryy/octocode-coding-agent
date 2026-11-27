import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testCompileCacheDir } from "./helpers/compile-cache.ts";
import { keepWorkerTitle } from "./helpers/worker-title.ts";

import "./helpers/no-request-rate.ts";

keepWorkerTitle();

// A suite started from inside Octocode (or one of its subagents) inherits that session's OCTOCODE_* identity and
// settings (OCTOCODE_SUBAGENT, OCTOCODE_CACHE_RETENTION, ...): drop them so results never depend on who ran the tests.
// The values configured in vitest.config.ts (`test.env`) are the suite's own and stay, and so do the run's test markers
// (`OCTOCODE_TEST_*`, `vitest.tmp.global.ts`), which guard the real agent database in every process a test starts.
const configured = new Set(["OCTOCODE_OFFLINE", "OCTOCODE_MCP", "OCTOCODE_MCP_DESKTOP", "OCTOCODE_MODELS_DEV"]);
for (const name of Object.keys(process.env)) {
	if (name.startsWith("OCTOCODE_") && !name.startsWith("OCTOCODE_TEST_") && !configured.has(name))
		delete process.env[name];
}

// Skills, settings and host configuration are also discovered under the user's home (~/.agents/skills,
// ~/.claude/skills, ...), so a developer's installed skills would leak into tests that expect only their own fixtures.
// `./test.sh` isolates HOME for the same reason; a direct `vitest` run gets an empty home too.
const home = mkdtempSync(join(tmpdir(), "octocode-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// The offline check after a network failure would send DNS lookups: tests answer it as online unless they set it.
process.env.OCTOCODE_NETWORK_PROBE ??= "online";
// No test opens a browser window: `/web` and an item link give the page's address (`browser/app-window.ts`).
process.env.OCTOCODE_OPEN_BROWSER = "0";
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
// Every CLI process a test starts compiles its TypeScript source through Node's compile cache and writes what was missing
// when it exits; a cache in the per-run temporary directory is cold every run (see helpers/compile-cache.ts).
process.env.NODE_COMPILE_CACHE = testCompileCacheDir();
