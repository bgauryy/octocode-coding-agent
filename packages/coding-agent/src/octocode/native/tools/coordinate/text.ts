import { plural } from "../../../shared/text.ts";

/** The `coordinate` tool's parameters and the short texts its replies and call rows show. */

/** Every field the `coordinate` schema accepts: a subagent's schema has no `id` or `goal` (`stop` and `join` are refused there before they are read). */
export interface CoordinateParams {
	action: "list" | "join" | "leave" | "lock" | "unlock" | "stop" | "merge" | "grant" | "changes";
	id?: string;
	branch?: string;
	goal?: string;
	paths?: string[];
	withinMinutes?: number;
	limit?: number;
	requests?: number;
	reason?: string;
}

/** ` (as a/, b.ts)` naming the reservations whose path differs from what was asked (normalised or merged); empty when none does. */
export function reshapedLeases(asked: readonly string[], leases: readonly { path: string; kind: string }[]): string {
	const given = new Set(asked.map((entry) => entry.trim()));
	const changed = leases
		.map((lease) => (lease.kind === "tree" ? `${lease.path}/` : lease.path))
		.filter((shown) => !given.has(shown) && !given.has(shown.replace(/\/$/u, "")));
	return changed.length > 0 ? ` (as ${changed.join(", ")})` : "";
}

/** One-line `coordinate` call summary: action, id, requests, path target and goal. */
export function coordinateSummary(args: Record<string, unknown>, paths: string[]): string {
	const { action, id, goal, requests } = args as Partial<CoordinateParams>;
	return [
		// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
		String(action ?? ""),
		// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
		id === undefined ? "" : String(id),
		requests === undefined ? "" : `+${String(requests)}`,
		paths.length > 1 ? plural(paths.length, "path") : (paths[0] ?? ""),
		// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- arguments are model output, unvalidated while the call renders
		goal ? `"${String(goal)}"` : "",
	]
		.filter(Boolean)
		.join(" ");
}
