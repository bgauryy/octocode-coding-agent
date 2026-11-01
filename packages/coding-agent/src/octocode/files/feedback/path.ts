import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath } from "../../shared/home/repo.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * Research envelopes compact row paths relative to an explicit `root` or `base`; without one, a relative path is
 * relative to `workspaceRoot`, the server's WORKSPACE_ROOT (the session cwd for the Octocode server).
 */
export function matchesResponsePath(
	envelope: unknown,
	row: Record<string, unknown>,
	target: string,
	workspaceRoot?: string,
): boolean {
	const data = asRecord(row.data);
	if (typeof data.path !== "string") return false;
	let shown = data.path;
	if (shown.startsWith("file://")) {
		try {
			shown = fileURLToPath(shown);
		} catch {
			return false;
		}
	}
	const root = isRecord(envelope)
		? typeof envelope.root === "string"
			? envelope.root
			: typeof envelope.base === "string"
				? envelope.base
				: workspaceRoot
		: workspaceRoot;
	if (!path.isAbsolute(shown) && (!root || !path.isAbsolute(root))) return false;
	return canonicalPath(path.isAbsolute(shown) ? shown : path.resolve(root!, shown)) === target;
}
