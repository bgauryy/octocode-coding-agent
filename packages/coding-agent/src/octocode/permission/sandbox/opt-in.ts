import type { McpSandboxPort, StdioWrappedLaunch } from "../../../../../mcp/src/api.ts";
import type { SandboxedLaunch } from "../../../utils/command-sandbox.ts";
import type { PermissionMode } from "../mode.ts";
import { sandboxPolicy } from "./policy.ts";
import { type SandboxPrompts, SrtCommandSandbox } from "./srt.ts";

/** What an opted-in process's policy follows: the session's permission mode and who answers its network questions. */
interface OptInSession {
	mode: () => PermissionMode;
	prompts: SandboxPrompts | undefined;
}

let session: OptInSession | undefined;
let sandbox: SrtCommandSandbox | undefined;

/** The session whose mode and questions opted-in hooks and MCP servers follow from now on. */
export function setOptInSandboxSession(mode: () => PermissionMode, prompts: SandboxPrompts | undefined): void {
	session = { mode, prompts };
	sandbox = undefined;
}

/** A word the POSIX shell reads back unchanged. */
export const shellWord = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * Wraps `command`, a `/bin/sh -c` script, for a process that opted into the sandbox (a hook's or an MCP server entry's
 * `sandbox: true`). It applies whatever `sandbox.mode` says, with the policy of an agent shell command started in `cwd`:
 * writes in that folder's workspace and the temporary folders, no reads of credentials, network through the proxy by
 * permission mode. Before a session starts the policy is `workspace`'s and nothing answers a new host, so every host
 * beyond loopback is refused. A sandbox that cannot start throws: an opted-in process never runs unsandboxed.
 */
export async function optInSandboxLaunch(command: string, cwd: string, what: string): Promise<SandboxedLaunch> {
	const current = session;
	sandbox ??= new SrtCommandSandbox(
		(folder) => sandboxPolicy(folder, { setting: "on", mode: current?.mode() ?? "workspace", env: process.env }),
		{ ...(current?.prompts ? { prompts: current.prompts } : {}), allowsUnsandboxed: false },
	);
	const launch = await sandbox.wrap({ shell: "/bin/sh", shellArgs: ["-c"], viaStdin: false, command, cwd });
	if (!launch) throw new Error(`The command sandbox did not cover ${what}; it was not started.`);
	return launch;
}

async function wrapStdio(launch: {
	command: string;
	args: readonly string[];
	cwd: string;
}): Promise<StdioWrappedLaunch> {
	const script = ["exec", ...[launch.command, ...launch.args].map(shellWord)].join(" ");
	const wrapped = await optInSandboxLaunch(script, launch.cwd, `the MCP server ${launch.command}`);
	return { file: wrapped.file, args: wrapped.args, env: wrapped.env, release: wrapped.release };
}

/** The sandbox of a stdio MCP server whose entry sets `sandbox: true` (`optInSandboxLaunch`). */
export const mcpSandboxPort: McpSandboxPort = { wrapStdio };
