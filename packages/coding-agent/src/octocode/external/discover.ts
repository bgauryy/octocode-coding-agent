import { findOnPath } from "../../../../common/src/find-on-path.ts";
import { RUNNERS } from "./runners.ts";

/** An ACP agent found on PATH: the connect arguments to use and the executable that matched. */
export interface InstalledAcpAgent {
	vendor: string;
	command: string;
	args: string[];
	path: string;
}

/**
 * Known ACP agents (the runners' adapters, `runners.ts`) installed on PATH. Nothing is started, so being listed does
 * not mean signed in or working.
 */
export function installedAcpAgents(env: NodeJS.ProcessEnv = process.env): InstalledAcpAgent[] {
	return RUNNERS.flatMap((runner) => {
		const path = findOnPath(runner.adapter.command, env);
		return path ? [{ vendor: runner.id, command: runner.adapter.command, args: [...runner.adapter.args], path }] : [];
	});
}
