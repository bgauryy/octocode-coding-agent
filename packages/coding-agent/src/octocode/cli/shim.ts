import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, sha256 } from "@octocodeai/octocode-common/atomic-file";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { getAgentDir, getCliInvocation } from "../../config.ts";
import { type OctocodeCli, cliRuntime, resolveOctocodeCli } from "./resolve.ts";

const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
/** cmd.exe expands `%name%` even inside double quotes; `%%` is a literal `%` in a batch file. */
const cmdQuote = (text: string): string => `"${text.replace(/%/g, "%%")}"`;

/** The program an agent shell's `octocode` starts: the runtime and the leading arguments (entry script, loader flags). */
export type AgentInvocation = { command: string; prefix: string[] };

const posixShim = (what: string, command: string[]): string =>
	`#!/bin/sh\n# ${what}, written by Octocode Code for agent shells.\nexec ${command.map(shQuote).join(" ")} "$@"\n`;
const cmdShim = (command: string[]): string => `@echo off\r\n${command.map(cmdQuote).join(" ")} %*\r\n`;

/**
 * The shim files, by name, for agent shells: `octocode` runs this coding agent (`agent`: the runtime and CLI entry that
 * started the session, from `getCliInvocation()`) and `octocode-cli` runs the research CLI `cli` with `runtime`. Each is
 * a POSIX script everywhere (agent shells are bash, Git Bash on Windows) and a `.cmd` beside it on Windows. Without
 * `cli`, only `octocode`.
 */
export function shimFiles(
	cli: OctocodeCli | undefined,
	runtime: string,
	platform: NodeJS.Platform,
	agent: AgentInvocation,
): Record<string, string> {
	const agentCommand = [agent.command, ...agent.prefix];
	const files: Record<string, string> = { octocode: posixShim("Octocode Code", agentCommand) };
	if (platform === "win32") files["octocode.cmd"] = cmdShim(agentCommand);
	if (cli) {
		files["octocode-cli"] = posixShim(`Octocode research CLI ${cli.version}`, [runtime, cli.bin]);
		if (platform === "win32") files["octocode-cli.cmd"] = cmdShim([runtime, cli.bin]);
	}
	return files;
}

/**
 * Writes the shims and returns their folder: `<agent dir>/octocode-cli/<hash of the runtime, bin and agent entry>`. The
 * folder holds nothing else, so no user file is ever replaced; sessions that resolve the same programs share it, and a
 * different runtime, bin or entry (a checkout beside a release) gets its own. Each file is written atomically and only
 * when its content differs, so concurrent sessions never see a partial script.
 */
export function writeOctocodeShim(
	cli: OctocodeCli | undefined,
	root = path.join(getAgentDir(), "octocode-cli"),
	runtime = cliRuntime(),
	platform: NodeJS.Platform = process.platform,
	agent: AgentInvocation = getCliInvocation(),
): string {
	const dir = path.join(
		root,
		sha256([runtime, cli?.bin ?? "", agent.command, ...agent.prefix].join("\0")).slice(0, 16),
	);
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(shimFiles(cli, runtime, platform, agent))) {
		const file = path.join(dir, name);
		let current: string | undefined;
		try {
			current = readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			current = undefined;
		}
		if (current !== content) atomicWriteFileSync(file, content, { mode: 0o755 });
	}
	return dir;
}

let shim: { dir?: string; cli?: boolean; error?: string } | undefined;

/**
 * The shim folder for agent shells, resolved and written once per process, failure included: a research CLI missing at
 * first use stays unavailable until restart (the `octocode` shim is written regardless). Undefined when the shims could
 * not be written (`octocodeShimError` says why). Never throws: `utils/shell.ts` calls it for every shell's path.
 */
export function octocodeShimDir(): string | undefined {
	if (!shim) {
		try {
			const cli = resolveOctocodeCli();
			shim = { dir: writeOctocodeShim(cli), cli: cli !== undefined };
		} catch (error) {
			shim = { error: `Could not set up the octocode shim for agent shells: ${errorMessage(error)}` };
		}
	}
	return shim.dir;
}

/** Why agent shells lack the shims (resolving the CLI or writing a shim failed); undefined when they have them. */
export function octocodeShimError(): string | undefined {
	octocodeShimDir();
	return shim?.error;
}

/**
 * Whether agent shells have `octocode-cli`, the research CLI: the dependency resolves and its shim is in place. Cheap
 * after the first call (cached for the process); the bash CLI guide reads it to list `octocode-cli` on PATH
 * (`files/bash/cli-guide.ts`).
 */
export function octocodeCliAvailable(): boolean {
	octocodeShimDir();
	return shim?.cli === true;
}
