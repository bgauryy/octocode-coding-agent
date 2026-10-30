import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * ACP adapters whose launch command is known, each with the vendor of the host it runs. Each entry was verified with its
 * CLI's help or an ACP handshake; add one only after the same check.
 */
const KNOWN_ACP_AGENTS: ReadonlyArray<{ vendor: string; command: string; args: readonly string[] }> = [
	{ vendor: "claude-code", command: "claude-agent-acp", args: [] },
	{ vendor: "codex", command: "codex-acp", args: [] },
	{ vendor: "gemini", command: "gemini", args: ["--acp"] },
	{ vendor: "opencode", command: "opencode", args: ["acp"] },
];

/** An ACP agent found on PATH: the connect arguments to use and the executable that matched. */
export interface InstalledAcpAgent {
	vendor: string;
	command: string;
	args: string[];
	path: string;
}

/** The first executable file named `command` on PATH, trying PATHEXT suffixes on Windows. */
function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const suffixes =
		process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
	for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const suffix of suffixes) {
			const candidate = join(dir, `${command}${suffix}`);
			try {
				if (!statSync(candidate).isFile()) continue;
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Missing or not executable: try the next candidate.
			}
		}
	}
	return undefined;
}

/** Known ACP agents installed on PATH. Nothing is started, so being listed does not mean signed in or working. */
export function installedAcpAgents(env: NodeJS.ProcessEnv = process.env): InstalledAcpAgent[] {
	return KNOWN_ACP_AGENTS.flatMap((agent) => {
		const path = findOnPath(agent.command, env);
		return path ? [{ vendor: agent.vendor, command: agent.command, args: [...agent.args], path }] : [];
	});
}
