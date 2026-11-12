import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { testCompileCacheDir } from "../helpers/compile-cache.ts";

// A suite started from inside Octocode (or one of its subagents) inherits that session's OCTOCODE_* identity and settings: start from none, so results never depend on who ran the tests.
for (const name of Object.keys(process.env)) if (name.startsWith("OCTOCODE_")) delete process.env[name];

// Tests must never touch the user's real home: ~/.octocode (its agent database is shared with every running Octocode), the
// skills and host configuration discovered under it. A test that blanks OCTOCODE_HOME falls back to <HOME>/.octocode/octocodecode,
// which is also temporary. Set before any module that reads either is imported.
// The folder trust gate ignores a trusted subtree that contains the home folder, so HOME sits beside the temporary
// directory the projects are created in (test/home-guard.global.ts makes one per run), never inside it.
const userHome =
	process.env.VITEST_TEST_USER_HOME ?? fs.mkdtempSync(path.join(path.dirname(os.tmpdir()), "octocode-test-userhome-"));
process.env.HOME = userHome;
process.env.USERPROFILE = userHome;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
// Tests that "restore" OCTOCODE_HOME/OCTOCODE_AGENT_DB restore these per-worker temporary paths, so late async work stays sandboxed.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-test-home-"));
process.env.OCTOCODE_HOME = home;
delete process.env.OCTOCODE_AGENT_DB;
// Nor the user's real ~/.octocode/agent: settings, credentials and sessions live there.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-test-agent-"));
process.env.OCTOCODE_CODING_AGENT_DIR = agentDir;
// The folder trust gate reads the agent database (under OCTOCODE_HOME here). Like a developer who trusted their code folder,
// the suite saves one subtree grant on the temp folder every test project is created in, recorded the way a user's "trust the
// parent" answer is, through a throwaway child folder; untrusted cases use their own dir.
const anchor = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-test-anchor-"));
const { grantFolder } = await import("../../src/octocode/trust/grants.ts");
grantFolder(anchor, "parent", { source: "command", surface: "cli" });
// The grant loaded the agent database modules; a test file's `vi.mock` of a node module (`node:child_process`) must apply to
// the copies it imports, not to ones this file already bound to the real module.
vi.resetModules();
// A fake Octocode never runs the Octocode server: no server process or first-prompt wait unless a test opts in (e2e runs the
// real server; mcp.test.ts passes its own env).
process.env.OCTOCODE_MCP = "0";
// Every process a test starts boots the CLI from TypeScript source, about 2 s of CPU each with nothing cached. Node's compile
// cache (keyed by file content and Node version, so a changed file is never served stale) halves that, and the folder sits
// beside the per-run temporary directory so later runs start warm too. Processes read it from the environment they are given.
process.env.NODE_COMPILE_CACHE = testCompileCacheDir();
// No models.dev requests from tests; the catalog is tested with an injected fetch.
process.env.OCTOCODE_MODELS_DEV = "0";

// `vi.waitFor` gives up after 1 s unless told otherwise. The suite polls for work done by child processes, sockets and
// git (journal lines, a started peer, a released lease), which takes longer than that when the machine is far more
// loaded than it has cores. The limit only decides when a condition that never comes is reported: a condition that
// holds returns at the next 50 ms check, so a call that passes its own `timeout` keeps it.
const WAIT_FOR_TIMEOUT_MS = 20_000;
const waitFor = vi.waitFor.bind(vi);
vi.waitFor = (callback, options) =>
	waitFor(callback, typeof options === "number" ? options : { timeout: WAIT_FOR_TIMEOUT_MS, ...options });
