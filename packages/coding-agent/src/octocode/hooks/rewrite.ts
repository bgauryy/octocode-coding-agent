import type { JsonObject } from "@octocodeai/octocode-ai";

export { rewriteFileQuery } from "../shared/claude-file.ts";

function text(value: unknown, field: string): string {
 if (typeof value !== "string") throw new Error(`Rewritten ${field} must be a string`);
 return value;
}

/** Codex rewrites the command string while retaining the invocation's execution options. */
export function rewriteCodexCommand(input: Record<string, unknown>, updated: JsonObject): Record<string, unknown> {
 return { ...input, command: text(updated.command, "command") };
}
