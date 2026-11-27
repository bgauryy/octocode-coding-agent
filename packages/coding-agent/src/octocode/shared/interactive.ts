import type { FeatureContext } from "../../core/features/index.ts";

/**
 * Whether a person is watching this session. `ctx.hasUI` is also true in RPC mode (the dialog protocol is functional),
 * and a subagent runs in RPC mode with its parent on the other end, so `hasUI` alone no longer means "someone can be asked".
 * Every check of that meaning goes through here; a `hasUI` check that only guards a UI call (a notify, a footer paint) stays.
 */
export function interactive(ctx: Pick<FeatureContext, "hasUI">, isSubagent: boolean): boolean {
	return ctx.hasUI && !isSubagent;
}
