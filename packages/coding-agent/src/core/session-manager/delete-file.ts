import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { transcripts, workspaces } from "../../../../db/src/api.ts";
import { isCurrentWorkspace } from "../../storage/workspace.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { readSessionHeaderForDiscovery } from "./storage.ts";

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink
 */
export async function deleteSessionFile(
	sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	const target = canonicalPath(sessionPath);
	const header = readSessionHeaderForDiscovery(sessionPath);
	// Try `trash` first (if installed)
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	const clearMirror = (method: "trash" | "unlink") => {
		try {
			if (header && !existsSync(target)) {
				const agent = sharedAgentDb();
				const saved = transcripts.stamp(agent.db, header.id);
				if (saved?.file === target) {
					if (saved.workspace_id) {
						const owner = workspaces.byId(agent.db, saved.workspace_id);
						if (!owner || !isCurrentWorkspace(owner)) throw new Error("Workspace identity changed");
					}
					transcripts.removeFile(agent.db, saved.file, header.id);
				}
			}
			return { ok: true, method };
		} catch (error) {
			return {
				ok: false,
				method,
				error: `Session file removed. Could not remove database transcript: ${errorMessage(error)}`,
			};
		}
	};

	// If trash reports success, or the file is gone afterwards, treat it as successful
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return clearMirror("trash");
	}

	// Fallback to permanent deletion
	try {
		await unlink(sessionPath);
		return clearMirror("unlink");
	} catch (err) {
		const unlinkError = errorMessage(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}
