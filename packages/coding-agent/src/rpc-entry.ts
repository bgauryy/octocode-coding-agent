#!/usr/bin/env node
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { initialTitle, setProcessTitle } from "./octocode/shared/process-title.ts";
import { dropForeignChildEnv } from "./octocode/subagents/process/child-env.ts";
import { main } from "./main.ts";

// An Octocode a subagent's command started is a top-level session, not that subagent.
dropForeignChildEnv();
// `octocode-agent-rpc-<id>` once the session exists, or the subagent's own `octocode-agent-<role>-<agent id>`.
setProcessTitle(initialTitle(process.env, "rpc"));
process.env.OCTOCODE_CODING_AGENT = "true";
process.env.AI_AGENT = "octocode";
process.emitWarning = () => {};

configureHttpDispatcher();

await main(["--mode", "rpc", ...process.argv.slice(2)]);
