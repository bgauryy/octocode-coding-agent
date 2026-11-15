import path from "node:path";
import type { AgentDb } from "../../../../db/src/api.ts";
import { openAgentDb } from "../../../src/storage/database.ts";
import { globalPaths } from "../../../src/storage/state-paths.ts";
import { grantFolder } from "../../../src/octocode/trust/grants.ts";
import type { Sandbox } from "../e2e-real-process-harness.ts";

/** The sandbox home's own agent database, checked to sit under it before opening (opening creates and migrates it). */
export function openSandboxDb(box: Pick<Sandbox, "home" | "env">): AgentDb {
	const file = path.join(globalPaths(box.env, box.home).agentState, "workspaces.db");
	const relative = path.relative(box.home, file);
	if (relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error(`Refusing to open a database outside the sandbox home: ${file}`);
	return openAgentDb(file, box.env);
}

/**
 * Trusts the sandbox's project in the sandbox's own agent database, through the trust store's API.
 *
 * `octocode trust add --yes` refuses inside an Octocode session's shell (`trust/session-shell.ts`), which is where an
 * agent runs these tests. The grant is the same record the command writes (`source: "command"`), and it goes only into
 * the sandbox home: the database is the sandbox home's own `workspaces.db` (the vitest process's home is not the sandbox's), checked to sit under it.
 */
export function seedTrust(box: Pick<Sandbox, "home" | "env" | "project">, folder: string = box.project): void {
	const db = openSandboxDb(box);
	try {
		grantFolder(folder, "folder", { source: "command", surface: "cli" }, { home: box.home, env: box.env, db });
	} finally {
		db.close();
	}
}
