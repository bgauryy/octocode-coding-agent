import { agentSpec } from "./agent.ts";
import { checkSpec } from "./check.ts";
import { commandSpec } from "./command.ts";
import { itemSpec } from "./item.ts";
import { removedUntil } from "./removed.ts";
import {
	type BaseCondition,
	type CheckOutcome,
	type ConditionSpec,
	type RunEnv,
	type TimerCondition,
} from "./types.ts";
import { unlockedSpec } from "./unlocked.ts";

/** The closed list of waits, in the order the tool documents them. `check` takes any of the others as its trigger. */
const BASE = [unlockedSpec, itemSpec, agentSpec, commandSpec] as unknown as ConditionSpec<BaseCondition>[];
const baseSpec = (kind: string) => BASE.find((spec) => spec.kind === kind);

const UNTIL_KINDS = [...BASE.map((spec) => spec.kind), "check"] as const;

const base = {
	parse(value: unknown): BaseCondition {
		const only = oneKey(
			value,
			BASE.map((spec) => spec.kind),
		);
		return baseSpec(only.kind)!.parse(only.value);
	},
	encode: (condition: BaseCondition) => baseSpec(condition.kind)!.encode(condition),
	decode: (kind: string, stored: string) => baseSpec(kind)?.decode(stored),
	describe: (condition: BaseCondition) => baseSpec(condition.kind)!.describe(condition),
	check: (condition: BaseCondition, env: RunEnv): Promise<CheckOutcome> =>
		baseSpec(condition.kind)!.check(condition, env),
	watch: (condition: BaseCondition, env: RunEnv, poke: () => void, failed: () => void) =>
		baseSpec(condition.kind)!.watch!(condition, env, poke, failed),
	hasWatch: (condition: BaseCondition) => baseSpec(condition.kind)?.watch !== undefined,
};
const CHECK = checkSpec(base);
const QUESTION_CAP = 500;

const specOf = (kind: string): ConditionSpec<TimerCondition> | undefined => (kind === "check" ? CHECK : baseSpec(kind));

/** The one key of an `until` argument: exactly one condition, named from the closed list. */
function oneKey(value: unknown, kinds: readonly string[]): { kind: string; value: unknown } {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`until takes one condition: ${UNTIL_KINDS.join(", ")}.`);
	const given = Object.entries(value).filter(([, each]) => each !== undefined);
	const unknown = given.filter(([key]) => !kinds.includes(key));
	if (unknown.length)
		throw new Error(
			`until has no condition ${unknown.map(([key]) => key).join(", ")}; the choices are ${kinds.join(", ")}.`,
		);
	if (given.length !== 1) throw new Error(`until takes exactly one condition: ${kinds.join(", ")}.`);
	return { kind: given[0][0], value: given[0][1] };
}

/** The condition an `until` argument names, or undefined without one; exactly one kind. */
export function parseUntil(until: unknown): TimerCondition | undefined {
	if (until === undefined) return undefined;
	const removed = removedUntil(until);
	if (removed) throw new Error(removed);
	if (typeof until === "object" && until !== null && "check" in until && until.check !== undefined) {
		// `check` is the question; the one other condition beside it is the trigger.
		const { check: question, ...rest } = until as Record<string, unknown>;
		if (typeof question !== "string" || !question.trim())
			throw new Error("until.check is the question to judge, a non-empty string.");
		if (question.length > QUESTION_CAP) throw new Error(`until.check is at most ${QUESTION_CAP} characters.`);
		if (Object.values(rest).every((each) => each === undefined))
			throw new Error("until.check needs one trigger condition beside it: item, agent, unlocked or command.");
		return { kind: "check", question: question.trim(), on: base.parse(rest) };
	}
	const only = oneKey(until, UNTIL_KINDS);
	return specOf(only.kind)!.parse(only.value);
}

/** The text and kind stored on the row. */
export const encodeCondition = (condition: TimerCondition) => specOf(condition.kind)!.encode(condition);
/** A stored condition; undefined for a kind or shape this version does not know (the row never fires). */
export function decodeCondition(kind: string, stored: string): TimerCondition | undefined {
	try {
		return specOf(kind)?.decode(stored);
	} catch {
		// Stored text that is not what its kind writes: an unreadable row is left to its deadline, not retried every tick.
		return undefined;
	}
}
export const describeCondition = (condition: TimerCondition) => specOf(condition.kind)!.describe(condition);
/** Whether the kind has an event source, and its poll intervals with and without one. */
export function conditionTiming(condition: TimerCondition): { watched: boolean; safetyMs: number; pollMs: number } {
	const spec = baseSpec(condition.kind === "check" ? condition.on.kind : condition.kind)!;
	return { watched: spec.watch !== undefined, safetyMs: spec.safetyMs, pollMs: spec.pollMs };
}
export const checkCondition = (condition: TimerCondition, env: RunEnv) => specOf(condition.kind)!.check(condition, env);
export const watchCondition = (condition: TimerCondition, env: RunEnv, poke: () => void, failed: () => void) =>
	specOf(condition.kind)!.watch!(condition, env, poke, failed);
