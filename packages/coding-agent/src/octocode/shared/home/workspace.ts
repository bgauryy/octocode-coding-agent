import path from "node:path";
import { TEAM_WORKSPACE_ENV } from "../../../../../common/src/env.ts";
import { workspaceDataRoot } from "../../../storage/workspace.ts";
import { canonicalPath } from "../../../../../common/src/canonical-path.ts";

/** The checkout to use for team communication and parent handoffs. An isolated agent keeps its own data identity. */
export function sessionWorkspace(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env[TEAM_WORKSPACE_ENV];
	return override && path.isAbsolute(override) ? canonicalPath(override) : workspaceDataRoot(cwd);
}
