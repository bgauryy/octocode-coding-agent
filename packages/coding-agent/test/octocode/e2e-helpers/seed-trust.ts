import path from "node:path";
import { openAgentDb } from "../../../src/config/database.ts";
import { globalPaths } from "../../../src/config/state-paths.ts";
import { grantFolder } from "../../../src/octocode/trust/grants.ts";
import type { Sandbox } from "../e2e-real-process-harness.ts";

/**
 * Trusts the sandbox's project in the sandbox's own agent database, through the trust store's API.
 *
 * `octocode trust add --yes` refuses inside an Octocode session's shell (`trust/session-shell.ts`), which is where an
 * agent runs these tests. The grant is the same record the command writes (`source: "command"`), and it goes only into
 * the sandbox home: the database is the sandbox home's own `workspaces.db` (the vitest process's home is not the sandbox's), checked to sit under it.
 */
export function seedTrust(box: Pick<Sandbox, "home" | "env" | "project">, folder: string = box.project): void {
	const file = path.join(globalPaths(box.env, box.home).agentState, "workspaces.db");
	const relative = path.relative(box.home, file);
	// Checked before opening: opening creates and migrates the database.
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error(`Refusing to seed trust outside the sandbox home: ${file}`);
	const db = openAgentDb(file, box.env);
	try {
		grantFolder(folder, "folder", { source: "command", surface: "cli" }, { home: box.home, env: box.env, db });
	} finally {
		db.close();
	}
}
