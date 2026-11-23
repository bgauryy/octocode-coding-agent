import type { ChildProcess } from "node:child_process";

/** What `spawnShell` asks a sandbox to wrap: one shell invocation. */
export interface CommandSandboxRequest {
	/** The shell executable. */
	shell: string;
	/** The shell's own arguments before the command (`-c`). */
	shellArgs: readonly string[];
	/** True when the shell reads the command from stdin instead of taking it as its last argument. */
	viaStdin: boolean;
	command: string;
	cwd: string;
}

/** The program and arguments that run the request under the sandbox; they replace the shell invocation. */
export interface SandboxedLaunch {
	file: string;
	args: string[];
	/** Variables the sandbox sets for the command (its network proxy), laid over the caller's environment. */
	env: Record<string, string>;
	/** Releases what the launch registered (its network allow list); called once the command ended or never started. */
	release(): void;
	/**
	 * What the sandbox refused the command while it ran (paths, hosts), one line each; empty when nothing. `wait`: the
	 * output showed a refusal, so wait a bounded time for a report that arrives after the command ended.
	 */
	denials(wait: boolean): Promise<string[]>;
}

/**
 * The seam between `spawnShell` and an operating-system sandbox. `octocode/permission/sandbox/` supplies the one
 * implementation (srt); a different backend replaces it without touching a caller.
 */
export interface CommandSandbox {
	/**
	 * The launch that runs the request sandboxed, or undefined when the command runs unsandboxed (a permission mode the
	 * sandbox does not cover, or the user's answer when the sandbox cannot start). Rejects, naming why, when a command
	 * cannot run sandboxed and may not run without: such a command is never started.
	 */
	wrap(request: CommandSandboxRequest): Promise<SandboxedLaunch | undefined>;
	/** Whether the agent may ask to run a command outside the sandbox (`sandbox: false`): the `sandbox.allowUnsandboxed` setting. */
	readonly allowsUnsandboxed: boolean;
	/** The session ended: release what the sandbox holds for the process (a proxy, a log monitor), now or once its last command ends; the next `wrap` starts it again. */
	close?(): Promise<void>;
}

let active: CommandSandbox | undefined;

/** Sandbox every command `spawnShell` starts from now on, or none with `undefined`. */
export function setCommandSandbox(sandbox: CommandSandbox | undefined): void {
	active = sandbox;
}

export function activeCommandSandbox(): CommandSandbox | undefined {
	return active;
}

const launches = new WeakMap<ChildProcess, SandboxedLaunch>();

/** Records the launch `child` runs under, for `sandboxDenials`. */
export function rememberLaunch(child: ChildProcess, launch: SandboxedLaunch): void {
	launches.set(child, launch);
}

/**
 * Output that a refusal by the sandbox prints: a file operation's errno text, or the proxy's answer for a host nobody
 * allowed (its 403 and the reason it carries).
 */
const REFUSAL =
	/Operation not permitted|\bEPERM\b|\bEACCES\b|Permission denied|Read-only file system|blocked by network allowlist|blocked-by-allowlist|(?:error|response|status)[: ]+403\b|\b403 Forbidden/i;
/** Output kept from one chunk to the next, so a refusal split across two chunks is still seen. */
const REFUSAL_TAIL = 64;

/** Watches a command's output as it streams for text a sandbox refusal prints. */
export class RefusalWatch {
	private tail = "";
	private found = false;

	push(chunk: Buffer | string): void {
		if (this.found) return;
		const text = this.tail + String(chunk);
		this.found = REFUSAL.test(text);
		this.tail = text.slice(-REFUSAL_TAIL);
	}

	get seen(): boolean {
		return this.found;
	}
}

const ESCAPE =
	"Writes outside the workspace or to protected paths, and hosts nobody allowed, fail this way. If the command needs one, run it again with sandbox: false (asks the user).";

/**
 * What the sandbox refused `child` while it ran, as a note for a failed command's result: a heading, one line per denied
 * path or host, and the way out. `suspected`: the output showed a refusal, so the sandbox's report is waited for, and
 * when none arrives in time the note still says the sandbox may have refused the command. Undefined for an
 * unsandboxed child, or when nothing was refused and nothing suggests it. Read it after the child exited.
 */
export async function sandboxDenials(
	child: ChildProcess,
	{ suspected }: { suspected: boolean },
): Promise<string | undefined> {
	const launch = launches.get(child);
	if (!launch) return undefined;
	const lines = await launch.denials(suspected);
	if (lines.length > 0) return ["The sandbox refused:", ...lines.map((line) => `  ${line}`), ESCAPE].join("\n");
	if (!suspected) return undefined;
	return `The command may have been refused by the sandbox: its output shows a permission error, and the sandbox reported no path or host in time. ${ESCAPE}`;
}
