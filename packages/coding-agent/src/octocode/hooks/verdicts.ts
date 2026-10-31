import type { HookVerdict } from "./contracts.ts";

/**
 * How hook verdicts combine. Hooks of one event run side by side and the dispatcher, the PreToolUse gate and the
 * PermissionRequest hook each reduce their verdicts; the rules live here so they cannot drift apart.
 */

/** The denial that decides among `verdicts`: one that interrupts the turn, else the first. */
export const decidingDenial = (verdicts: readonly HookVerdict[]): HookVerdict | undefined =>
	verdicts.find((verdict) => verdict.permissionDecision === "deny" && verdict.permissionInterrupt) ??
	verdicts.find((verdict) => verdict.permissionDecision === "deny");

/** One PermissionRequest answer from hooks that ran side by side: a denial beats an allow, and no decision is no answer. */
export function reducePermission(verdicts: readonly HookVerdict[]): HookVerdict {
	const deny = decidingDenial(verdicts);
	if (deny)
		return {
			permissionDecision: "deny",
			block: deny.block,
			...(verdicts.some((verdict) => verdict.permissionInterrupt) ? { permissionInterrupt: true as const } : {}),
		};
	return verdicts.some((verdict) => verdict.permissionDecision === "allow") ? { permissionDecision: "allow" } : {};
}

/** The first verdict that rewrites the call's input; its `updatedInputProtocol` says which adapter shaped it. */
export const firstRewrite = (verdicts: readonly HookVerdict[]): HookVerdict | undefined =>
	verdicts.find((verdict) => verdict.updatedInput);

/** Whether two hooks rewrote the same input differently (equal rewrites agree). */
export function conflictingRewrites(verdicts: readonly HookVerdict[]): boolean {
	const rewrites = verdicts.flatMap((verdict) => (verdict.updatedInput ? [JSON.stringify(verdict.updatedInput)] : []));
	return rewrites.some((rewrite) => rewrite !== rewrites[0]);
}
