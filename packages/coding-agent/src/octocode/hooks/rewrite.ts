import type { JsonObject } from "@octocodeai/octocode-ai";
import { rewrittenString } from "../shared/claude-file.ts";

/** Codex rewrites the command string while retaining the invocation's execution options. */
export function rewriteCodexCommand(input: Record<string, unknown>, updated: JsonObject): Record<string, unknown> {
	return { ...input, command: rewrittenString(updated.command, "command") };
}
