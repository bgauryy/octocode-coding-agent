import type { HookVerdict } from "./contracts.ts";
import { capContext } from "./runner.ts";

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

export interface CombineOptions {
	/** The verdicts come from separate calls, each with its own input rewrite: the caller applies them, so different rewrites do not conflict. */
	separateCalls?: boolean;
	/** A stop in any verdict stops the combined one too. */
	keepStop?: boolean;
	/** Contexts are joined without the size cap. */
	uncappedContext?: boolean;
}

const joined = (verdicts: readonly HookVerdict[], pick: (verdict: HookVerdict) => string | undefined): string =>
	verdicts.map(pick).filter(Boolean).join("\n\n");

/**
 * The one place the verdicts of hooks that ran side by side become one: blocks, contexts, asks and continue reasons
 * are joined in config order and capped, the first rewrite wins (two different ones block), and the flags any hook set
 * are kept.
 */
export function combineVerdicts(verdicts: readonly HookVerdict[], options: CombineOptions = {}): HookVerdict {
	if (!options.separateCalls && conflictingRewrites(verdicts))
		return { block: "Conflicting hook input rewrites; call not executed" };
	const rewrite = firstRewrite(verdicts);
	const block = joined(verdicts, (verdict) => verdict.block);
	const context = joined(verdicts, (verdict) => verdict.context);
	const ask = joined(verdicts, (verdict) => verdict.ask);
	const continueReason = joined(verdicts, (verdict) => verdict.continueReason);
	return {
		...(rewrite ? { updatedInput: rewrite.updatedInput, updatedInputProtocol: rewrite.updatedInputProtocol } : {}),
		...(verdicts.some((verdict) => verdict.continueReason) ? { continueReason: capContext(continueReason) } : {}),
		...(verdicts.some((verdict) => verdict.replaceResult) ? { replaceResult: true as const } : {}),
		...(verdicts.some((verdict) => verdict.rejectNested) ? { rejectNested: true as const } : {}),
		...(options.keepStop && verdicts.some((verdict) => verdict.stop) ? { stop: true as const } : {}),
		...(verdicts.some((verdict) => verdict.cancelCompaction) ? { cancelCompaction: true as const } : {}),
		...(block ? { block: capContext(block) } : {}),
		...(context ? { context: options.uncappedContext ? context : capContext(context) } : {}),
		...(ask ? { ask: capContext(ask) } : {}),
	};
}

/**
 * What a hook's answer may do in a subagent in the `decisions` hook mode: refuse the call or ask about it. Everything
 * else it returned is dropped: context, a rewritten input, messages, a turn halt, and an allow (a PreToolUse or
 * PermissionRequest hook's `allow` grants nothing there). `error` stays so a failed hook is still reported and still
 * fails open.
 */
export const decisionOnly = (verdict: HookVerdict): HookVerdict => ({
	...(verdict.error ? { error: verdict.error } : {}),
	...(verdict.block ? { block: verdict.block } : {}),
	...(verdict.ask ? { ask: verdict.ask } : {}),
	...(verdict.permissionDecision === "deny" ? { permissionDecision: "deny" as const } : {}),
});
