#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { dropForeignChildEnv } from "./octocode/subagents/process/child-env.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
// An Octocode a subagent's command started is a top-level session, not that subagent.
dropForeignChildEnv();
process.env.OCTOCODE_CODING_AGENT = "true";
process.env.AI_AGENT = "octocode";
process.emitWarning = () => {};

configureHttpDispatcher();

await main(["--mode", "rpc", ...process.argv.slice(2)]);
