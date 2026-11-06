import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, sha256 } from "../../../../common/src/atomic-file.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { getAgentDir } from "../../config.ts";
import { type OctocodeCli, cliRuntime, resolveOctocodeCli } from "./resolve.ts";

const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;
/** cmd.exe expands `%name%` even inside double quotes; `%%` is a literal `%` in a batch file. */
const cmdQuote = (text: string): string => `"${text.replace(/%/g, "%%")}"`;

/**
 * The shim files, by name, that make `octocode` run `cli` with `runtime`: a POSIX script everywhere (agent shells are
 * bash, Git Bash on Windows) and a `.cmd` beside it on Windows.
 */
export function shimFiles(cli: OctocodeCli, runtime: string, platform: NodeJS.Platform): Record<string, string> {
	const files: Record<string, string> = {
		octocode: `#!/bin/sh\n# Octocode research CLI ${cli.version}, written by Octocode Code for agent shells.\nexec ${shQuote(runtime)} ${shQuote(cli.bin)} "$@"\n`,
	};
	if (platform === "win32") files["octocode.cmd"] = `@echo off\r\n${cmdQuote(runtime)} ${cmdQuote(cli.bin)} %*\r\n`;
	return files;
}

/**
 * Writes the shim for `cli` and returns its folder: `<agent dir>/octocode-cli/<hash of runtime and bin>`. The folder
 * holds nothing else, so no user file is ever replaced; sessions that resolve the same CLI share it, and a different
 * runtime or bin (a checkout beside a release) gets its own. Each file is written atomically and only when its content
 * differs, so concurrent sessions never see a partial script.
 */
export function writeOctocodeShim(
	cli: OctocodeCli,
	root = path.join(getAgentDir(), "octocode-cli"),
	runtime = cliRuntime(),
	platform: NodeJS.Platform = process.platform,
): string {
	const dir = path.join(root, sha256(`${runtime}\0${cli.bin}`).slice(0, 16));
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(shimFiles(cli, runtime, platform))) {
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

let shim: { dir?: string; error?: string } | undefined;

/**
 * The shim folder for agent shells, resolved and written once per process, failure included: a CLI missing at first use
 * stays unavailable until restart. Undefined when the CLI does not resolve or the shim could not be written
 * (`octocodeShimError` says why). Never throws: `utils/shell.ts` calls it for every shell's path.
 */
export function octocodeShimDir(): string | undefined {
	if (!shim) {
		try {
			const cli = resolveOctocodeCli();
			shim = cli ? { dir: writeOctocodeShim(cli) } : {};
		} catch (error) {
			shim = { error: `Could not set up the octocode shim for agent shells: ${errorMessage(error)}` };
		}
	}
	return shim.dir;
}

/** Why agent shells lack the shim (resolving the CLI or writing the shim failed); undefined when they have it or there is no CLI. */
export function octocodeShimError(): string | undefined {
	octocodeShimDir();
	return shim?.error;
}

/**
 * Whether agent shells run the research CLI as `octocode`: the dependency resolves and its shim is in place. Cheap after
 * the first call (cached for the process); the bash CLI guide reads it to list `octocode` on PATH (`files/bash/cli-guide.ts`).
 */
export function octocodeCliAvailable(): boolean {
	return octocodeShimDir() !== undefined;
}
