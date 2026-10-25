import type { JsonObject } from "@octocodeai/octocode-ai";

/** Claude uses milliseconds and a distinct background flag; native options stay private to the host. */
export function projectClaudeBash(input: Record<string, unknown>): Record<string, unknown> {
	return {
		command: input.command,
		...(typeof input.description === "string" ? { description: input.description } : {}),
		...(typeof input.timeout === "number" ? { timeout: input.timeout * 1000 } : {}),
		...(typeof input.background === "boolean" ? { run_in_background: input.background } : {}),
	};
}

/** Nonempty source input replaces the invocation; an empty object preserves it but still requires policy review. */
export function rewriteClaudeBash(original: Record<string, unknown>, input: JsonObject): Record<string, unknown> {
	if (original.type === "powershell") throw new Error("Claude Bash replacement cannot change a PowerShell invocation");
	if (Object.keys(input).length === 0) return structuredClone(original);
	if (typeof input.command !== "string") throw new Error("Claude Bash replacement command must be a string");
	if (
		input.timeout !== undefined &&
		(typeof input.timeout !== "number" || !Number.isFinite(input.timeout) || input.timeout < 0)
	)
		throw new Error("Claude Bash timeout must be finite nonnegative milliseconds");
	if (input.run_in_background !== undefined && typeof input.run_in_background !== "boolean")
		throw new Error("Claude Bash run_in_background must be a boolean");
	if (input.description !== undefined && typeof input.description !== "string")
		throw new Error("Claude Bash description must be a string");
	return {
		command: input.command,
		// The hook rewrites the command, not the model's stated goal: the call still needs its `reason`.
		...(typeof original.reason === "string" ? { reason: original.reason } : {}),
		...(typeof input.description === "string" ? { description: input.description } : {}),
		...(typeof input.timeout === "number" ? { timeout: input.timeout / 1000 } : {}),
		...(typeof input.run_in_background === "boolean" ? { background: input.run_in_background } : {}),
	};
}
