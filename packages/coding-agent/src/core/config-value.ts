/**
 * The host's entry to `@octocodeai/octocode-ai/utils/resolve-config-value`: binds `!command` config values to the shell
 * the bash tool uses (it matters on Windows) before any caller can resolve one. Coding-agent code imports the
 * resolver from here, so every path that runs a command, including standalone SDK and web-daemon reads, gets that shell.
 */
import { setConfigValueShell } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { getShellConfig } from "../utils/shell.ts";

setConfigValueShell(() => getShellConfig());

export * from "@octocodeai/octocode-ai/utils/resolve-config-value";
