/**
 * The shell command an `until` argument carries, the one condition beside a `check` question included, or undefined. The one reader
 * the permission pipeline (`tool-gates.ts`) and plan mode (`plan/gate.ts`) share from this leaf, so a command nested in a `check` is
 * decided as the bash call it is. A leaf module: it imports nothing.
 */
export function untilCommand(input: unknown): string | undefined {
	return commandOf((input as { until?: unknown } | null | undefined)?.until);
}

function commandOf(value: unknown): string | undefined {
	const command = typeof value === "object" && value !== null ? (value as { command?: unknown }).command : undefined;
	return typeof command === "string" && command.trim() ? command : undefined;
}
