import type { ExtensionAPI } from "../core/features/index.ts";
import { registerReadDedupe } from "./files/dedupe.ts";
import { registerLoopGuard } from "./loop-guard.ts";
import type { Gate } from "./permission/judge.ts";

/**
 * What keeps a run from wasting itself, after the file guard's `tool_result` handler (the read dedupe must see the text a
 * read returned). Returns the loop guard's `loop` step for the `tool_call` pipeline (`tool-gates.ts`).
 */
export function registerRunGuards(api: ExtensionAPI): { loop: Gate } {
	registerReadDedupe(api);
	return { loop: registerLoopGuard(api) };
}
