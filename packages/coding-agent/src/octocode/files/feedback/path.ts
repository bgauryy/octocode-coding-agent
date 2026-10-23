import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalPath } from "../../shared/home.ts";
import { isRecord } from "../../shared/util.ts";

/** Research envelopes compact row paths relative to an explicit `root` or `base`. */
export function matchesResponsePath(envelope: unknown, row: Record<string, unknown>, target: string): boolean {
	const data = isRecord(row.data) ? row.data : {};
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
				: undefined
		: undefined;
	if (!path.isAbsolute(shown) && (!root || !path.isAbsolute(root))) return false;
	return canonicalPath(path.isAbsolute(shown) ? shown : path.resolve(root!, shown)) === target;
}
