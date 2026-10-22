#!/usr/bin/env node
import { runResearchCommand } from "./cli/research.ts";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();
const args = process.argv.slice(2);
if (!runResearchCommand(args)) main(args);
