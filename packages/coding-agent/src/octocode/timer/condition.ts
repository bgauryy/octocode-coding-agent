import { checkCondition, watchCondition } from "./conditions/index.ts";
import type { CheckOutcome, ConditionDeps, TimerCondition } from "./conditions/types.ts";

export type { ConditionDeps };

/** What one check needs besides the condition: where it runs and what the row recorded. */
export interface CheckInput {
	cwd: string;
	/** The wait is at its deadline: this check is its last. */
	expiring?: boolean;
	signal?: AbortSignal;
	row?: { id: number; checks: number; spentUsd: number; sessionId: string };
}

/**
 * Checks a timer's condition through the closed registry (`conditions/`): each kind decides its own met rule, and the rules
 * a bash call meets at that moment apply to `command` (plan mode, a read-only role).
 */
export function conditionChecker(deps: ConditionDeps) {
	return (condition: TimerCondition, input: CheckInput | string): Promise<CheckOutcome> => {
		const given = typeof input === "string" ? { cwd: input } : input;
		return checkCondition(condition, { ...given, deps });
	};
}

/** An event source for a condition (the database file); the scheduler turns each poke into one check. */
export function conditionWatcher(deps: ConditionDeps) {
	return (condition: TimerCondition, cwd: string, poke: () => void, failed: () => void) =>
		watchCondition(condition, { cwd, deps }, poke, failed);
}
