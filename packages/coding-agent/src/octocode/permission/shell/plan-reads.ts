import { shellMutation } from "./mutation.ts";
import { readOnlyCommand } from "./read-only.ts";

/**
 * Whether plan mode may run `command`: made only of programs the read-only list knows (`ls`, `cat`, `rg`, `git log`,
 * `git diff`...), which the mutation guard also finds free of writes. The list is the authority: the mutation guard alone
 * does not see what `git branch -D`, `node -e` or a test runner does, so those stay blocked. The permission layer still
 * decides each call.
 */
export function planReadOnly(command: string): boolean {
	if (!readOnlyCommand(command)) return false;
	const effect = shellMutation(command);
	return effect.writes.length === 0 && effect.opaque.length === 0 && !effect.uncertain;
}
