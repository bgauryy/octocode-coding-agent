import type { ExtensionAPI } from "../core/extensions/index.ts";
import { registerReadDedupe } from "./files/dedupe.ts";
import { registerVerifyNudge } from "./files/verify-nudge.ts";
import { envFlag } from "./shared/env.ts";
import { registerLoopGuard } from "./loop-guard.ts";

/**
 * What keeps a run from wasting itself, after the file guard's `tool_result` handler (the read dedupe must see the text a
 * read returned) and after the Stop hook (the verify nudge steps aside for a continuation that hook already asked for).
 * `OCTOCODE_VERIFY_NUDGE=0` turns the nudge off.
 */
export function registerRunGuards(pi: ExtensionAPI): void {
	registerReadDedupe(pi);
	registerLoopGuard(pi);
	if (envFlag(process.env, "OCTOCODE_VERIFY_NUDGE", true)) registerVerifyNudge(pi);
}
