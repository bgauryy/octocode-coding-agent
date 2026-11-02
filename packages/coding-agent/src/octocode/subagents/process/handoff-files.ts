import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { adoptSkillResourceSnapshot } from "../../../core/skill-resource-snapshot.ts";
import { serializeMcpSessionServers } from "../../../../../mcp/src/session-servers.ts";
import { privateDir, sessionOutputDir } from "../../shared/home.ts";
import type { Identity } from "./env.ts";
import { childSession, reportDir } from "./session.ts";
import { PRIVATE_FILE_MODE } from "../../../../../common/src/file-mode.ts";

/** Private files passed to a child by path; the caller removes them when the child exits. */
export interface ChildResourceFiles {
	skillSnapshotFile?: string;
	mcpServersFile?: string;
}

/** Store a result contract and prepare the skill/MCP handoffs before spawning the child. */
export function prepareChildResourceFiles(identity: Identity): ChildResourceFiles {
	const files: ChildResourceFiles = {};
	try {
		if (identity.resultContract) {
			const session = childSession(identity);
			fs.mkdirSync(session.dir, { recursive: true, mode: 0o700 });
			const file = path.join(session.dir, "result-schema-v1.json");
			const snapshot = JSON.stringify({
				version: 1,
				schemaHash: identity.resultContract.hash,
				schema: identity.resultContract.schema,
			});
			try {
				fs.writeFileSync(file, snapshot, { flag: "wx", mode: PRIVATE_FILE_MODE });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || fs.readFileSync(file, "utf8") !== snapshot)
					throw new Error("Subagent result schema snapshot could not be persisted unchanged", { cause: error });
			}
		}
		if (identity.skillResources) {
			adoptSkillResourceSnapshot(identity.skillResources);
			const directory = privateDir(identity.scratch ?? reportDir(identity.id) ?? sessionOutputDir("output"));
			const file = path.join(directory, `skills-${randomBytes(16).toString("hex")}.json`);
			const fd = fs.openSync(file, "wx", PRIVATE_FILE_MODE);
			files.skillSnapshotFile = file;
			try {
				fs.writeFileSync(fd, JSON.stringify(identity.skillResources));
			} finally {
				fs.closeSync(fd);
			}
		}
		const mcpServers = serializeMcpSessionServers(identity.mcpServers ?? {}, identity.mcpStopped);
		if (mcpServers) {
			// Server env and headers may hold credentials the user entered: an owner-only file, removed when the run ends.
			const directory = privateDir(identity.scratch ?? reportDir(identity.id) ?? sessionOutputDir("output"));
			const file = path.join(directory, `mcp-servers-${randomBytes(16).toString("hex")}.json`);
			const fd = fs.openSync(file, "wx", PRIVATE_FILE_MODE);
			files.mcpServersFile = file;
			try {
				fs.writeFileSync(fd, mcpServers);
			} finally {
				fs.closeSync(fd);
			}
		}
		return files;
	} catch (error) {
		// Creation may fail after a previous private handoff was written. The caller has no paths until we return.
		removeChildResourceFiles(files);
		throw error;
	}
}

/** Remove temporary handoffs without hiding the child's original failure or report. */
export function removeChildResourceFiles(files: ChildResourceFiles): void {
	for (const file of [files.skillSnapshotFile, files.mcpServersFile]) {
		if (!file) continue;
		try {
			fs.rmSync(file, { force: true });
		} catch {
			process.stderr.write("Unable to remove a private subagent handoff file\n");
		}
	}
}
