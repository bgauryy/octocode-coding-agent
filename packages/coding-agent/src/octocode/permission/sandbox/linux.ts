import { spawnSync } from "node:child_process";
import path from "node:path";
import { findOnPath } from "@octocodeai/octocode-common/find-on-path";
import { getBinDir } from "../../../config.ts";

/** Where the sandbox library runs: macOS wraps a command with Seatbelt, Linux with bubblewrap (bwrap). */
const SUPPORTED = new Set<NodeJS.Platform>(["darwin", "linux"]);

/** Why commands cannot be sandboxed on `platform`, or undefined where they can. */
export function unsupportedPlatform(platform: NodeJS.Platform = process.platform): string | undefined {
	return SUPPORTED.has(platform)
		? undefined
		: `the command sandbox supports macOS and Linux only (this is ${platform})`;
}

/** The ripgrep the library scans for nested repositories with: Octocode's own copy, else the one on PATH. */
export function ripgrepCommand(binDir: string = getBinDir(), env: NodeJS.ProcessEnv = process.env): string {
	return findOnPath(path.join(binDir, "rg"), env) ?? findOnPath("rg", env) ?? "rg";
}

/** What to install for each missing program the library names. */
const INSTALL_BUBBLEWRAP =
	"install the bubblewrap and socat packages (for example `sudo apt install bubblewrap socat`)";
const INSTALL: [RegExp, string][] = [
	[/bubblewrap|socat/, INSTALL_BUBBLEWRAP],
	[/ripgrep/, "install ripgrep (the `ripgrep` package)"],
];

/** The library's dependency errors, followed by what to install. */
export function missingPrograms(errors: readonly string[]): string {
	const fixes = INSTALL.filter(([pattern]) => errors.some((error) => pattern.test(error))).map(([, fix]) => fix);
	return [errors.join("; "), ...fixes].join("; ");
}

/** What a program run reports; `error` when it could not start or ran past its time. */
interface ProbeResult {
	status: number | null;
	stderr: string;
	error?: Error;
}

export type ProbeRun = (file: string, args: string[]) => ProbeResult;

/** The namespaces and mounts the library asks bubblewrap for: one run shows the kernel allows them. */
export const PROBE_ARGS = [
	"--new-session",
	"--die-with-parent",
	"--unshare-net",
	"--unshare-pid",
	"--ro-bind",
	"/",
	"/",
	"--dev",
	"/dev",
	"--proc",
	"/proc",
	"--",
	"true",
];

const PROBE_TIMEOUT_MS = 5000;

const runProgram: ProbeRun = (file, args) => {
	const result = spawnSync(file, args, {
		encoding: "utf8",
		timeout: PROBE_TIMEOUT_MS,
		stdio: ["ignore", "ignore", "pipe"],
	});
	return { status: result.status, stderr: result.stderr ?? "", ...(result.error ? { error: result.error } : {}) };
};

/** bubblewrap's words when the kernel or a security module refuses it a user namespace. */
const NO_NAMESPACE =
	/uid map|user namespace|namespace.*(denied|not permitted)|No permissions to creat|Operation not permitted/i;

/**
 * Why bubblewrap at `bwrap` cannot sandbox a command here, or undefined when a trial run succeeds. The library checks
 * only that the programs exist; a kernel without unprivileged user namespaces (Ubuntu 23.10 and later restrict them
 * through AppArmor), or a container, makes every command fail instead, so this runs `true` the way commands run.
 */
export function bubblewrapProblem(bwrap: string | undefined, run: ProbeRun = runProgram): string | undefined {
	if (!bwrap) return `bubblewrap (bwrap) not installed; ${INSTALL_BUBBLEWRAP}`;
	const result = run(bwrap, PROBE_ARGS);
	if (!result.error && result.status === 0) return undefined;
	const detail = result.error?.message ?? (result.stderr.trim().split("\n")[0] || `exit status ${result.status}`);
	const reason = `bubblewrap cannot create a sandbox here (${detail})`;
	return NO_NAMESPACE.test(detail)
		? `${reason}; unprivileged user namespaces are off: allow them for bwrap (on Ubuntu, an AppArmor profile or the kernel.apparmor_restrict_unprivileged_userns setting), or run Octocode outside a container`
		: reason;
}

/**
 * Checks what the library needs on Linux and returns the configuration it starts with. `check` is the library's
 * dependency check, given the ripgrep to use. Throws naming what to install or allow: a sandbox that cannot run its
 * commands must not report that it started.
 */
export function linuxStart(
	check: (ripgrep: { command: string }) => { errors: string[] },
	run: ProbeRun = runProgram,
): { ripgrep: { command: string } } {
	const ripgrep = { command: ripgrepCommand() };
	const { errors } = check(ripgrep);
	if (errors.length > 0) throw new Error(`The command sandbox cannot start: ${missingPrograms(errors)}.`);
	const problem = bubblewrapProblem(findOnPath("bwrap"), run);
	if (problem) throw new Error(`The command sandbox cannot start: ${problem}.`);
	return { ripgrep };
}
