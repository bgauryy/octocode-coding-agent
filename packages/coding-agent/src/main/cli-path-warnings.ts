import { existsSync } from "node:fs";
import { isLocalPath } from "@octocodeai/octocode-common/paths";
import type { AgentSessionRuntimeDiagnostic } from "../core/agent-session-services.ts";

/**
 * A warning for each local path the user named with a repeatable resource flag (`--prompt-template`, `--theme`) that is
 * not there. Such a path loads nothing; the run goes on, so this only says why a prompt or a theme is missing. `paths`
 * are already resolved against the startup folder (`resolveCliPaths`).
 */
export function missingCliPathWarnings(
	flag: string,
	what: string,
	paths: readonly string[] | undefined,
): AgentSessionRuntimeDiagnostic[] {
	return (paths ?? [])
		.filter((path) => isLocalPath(path) && !existsSync(path))
		.map((path) => ({
			type: "warning" as const,
			message: `${flag} path does not exist: ${path}. No ${what} was loaded from it.`,
		}));
}
