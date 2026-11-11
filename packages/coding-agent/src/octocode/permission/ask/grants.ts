import type { ActionClass } from "../mode.ts";

/** Clear one action's session-wide decision and its exact grants and denials; leave every other action alone. */
export function clearActionGrants(
	action: ActionClass,
	kinds: Set<ActionClass>,
	answers: readonly Map<string, string>[],
): number {
	let count = kinds.delete(action) ? 1 : 0;
	for (const decisions of answers)
		for (const key of decisions.keys()) if (key.startsWith(`${action}\0`) && decisions.delete(key)) count++;
	return count;
}
