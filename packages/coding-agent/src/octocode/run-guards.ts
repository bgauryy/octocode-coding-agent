import type { ExtensionAPI } from "../core/extensions/index.ts";
import { registerReadDedupe } from "./files/dedupe.ts";
import { registerLoopGuard } from "./loop-guard.ts";

/** What keeps a run from wasting itself, after the file guard's `tool_result` handler (the read dedupe must see the text a read returned). */
export function registerRunGuards(api: ExtensionAPI): void {
	registerReadDedupe(api);
	registerLoopGuard(api);
}
