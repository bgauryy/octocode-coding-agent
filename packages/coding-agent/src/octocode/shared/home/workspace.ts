import path from "node:path";
import { TEAM_WORKSPACE_ENV } from "../../../../../common/src/env.ts";
import { canonicalPath, repoKey } from "./repo.ts";

/** The checkout, or the parent's checkout inherited by an isolated child. */
export function sessionWorkspace(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env[TEAM_WORKSPACE_ENV];
	return override && path.isAbsolute(override) ? canonicalPath(override) : repoKey(cwd).root;
}
