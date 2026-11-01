import { readOnlyCommand } from "./read-only.ts";

/**
 * Whether plan mode may run `command`: made only of programs the read-only list knows (`ls`, `cat`, `rg`, `git log`,
 * `git diff`...), without an option that writes or runs another program. The list is the authority: the mutation parse
 * does not see what `git branch -D`, `node -e` or a test runner does, so those stay blocked (and `shellMutation` itself
 * returns no writes for a command this list accepts, so it adds no second check). The permission layer still decides
 * each call.
 */
export function planReadOnly(command: string): boolean {
	return readOnlyCommand(command);
}
