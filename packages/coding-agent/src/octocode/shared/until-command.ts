/**
 * The shell command a `wait` call carries (`on` with event `check.result` and a `filter.command`, beside a `check` question or
 * not), or undefined. The one reader the permission pipeline (`tool-gates.ts`) and plan mode (`plan/gate.ts`) share from this
 * leaf, so a command in a wait is decided as the bash call it is. A leaf module: it imports nothing.
 */
export function untilCommand(input: unknown): string | undefined {
	const filter = (input as { filter?: unknown } | null | undefined)?.filter;
	const command = typeof filter === "object" && filter !== null ? (filter as { command?: unknown }).command : undefined;
	return typeof command === "string" && command.trim() ? command : undefined;
}
