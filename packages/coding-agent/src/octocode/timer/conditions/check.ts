import type { BaseCondition, CheckCondition, CheckOutcome, ConditionSpec } from "./types.ts";

/** What the registry gives `check`: the spec of the `on` kind. */
export interface BaseSpecs {
	parse(value: unknown, kinds?: readonly string[]): BaseCondition;
	encode(condition: BaseCondition): string;
	decode(kind: string, stored: string): BaseCondition | undefined;
	describe(condition: BaseCondition): string;
	check(condition: BaseCondition, env: Parameters<ConditionSpec<BaseCondition>["check"]>[1]): Promise<CheckOutcome>;
	watch: NonNullable<ConditionSpec<BaseCondition>["watch"]>;
	hasWatch(condition: BaseCondition): boolean;
}

/**
 * `check`: a small model judges `question` after the deterministic condition `on` fired and its evidence changed. The
 * model has no tools and sees only the evidence the code gathered. Its spend and gating live in `judge.ts`; this kind only
 * hands it the trigger. A wait whose `on` never fires costs nothing.
 */
export function checkSpec(base: BaseSpecs): ConditionSpec<CheckCondition> {
	return {
		kind: "check",
		parse() {
			throw new Error("check is parsed with its trigger by parseUntil.");
		},
		encode: (condition) =>
			JSON.stringify({
				question: condition.question,
				on: { kind: condition.on.kind, value: base.encode(condition.on) },
			}),
		decode(stored) {
			const parsed = JSON.parse(stored) as { question?: unknown; on?: { kind?: unknown; value?: unknown } };
			if (
				typeof parsed.question !== "string" ||
				typeof parsed.on?.kind !== "string" ||
				typeof parsed.on.value !== "string"
			)
				return undefined;
			const on = base.decode(parsed.on.kind, parsed.on.value);
			return on ? { kind: "check", question: parsed.question, on } : undefined;
		},
		describe: (condition) => `the model judges "${condition.question}" after ${base.describe(condition.on)}`,
		// Timing and event source are those of `on` (`conditionTiming`); a trigger without one has nothing to watch.
		safetyMs: 30_000,
		pollMs: 15_000,
		async check(condition, env) {
			const outcome = await base.check(condition.on, env);
			if (outcome.refused || !outcome.met || !env.row) return { ...outcome, met: false };
			const verdict = await env.deps.judge({
				id: env.row.id,
				sessionId: env.row.sessionId,
				question: condition.question,
				trigger: base.describe(condition.on),
				evidence: outcome.output,
				checks: env.row.checks,
				spentUsd: env.row.spentUsd,
			});
			if (verdict.verdict === "skipped") return { met: false, exit: null, output: verdict.reason };
			if (verdict.verdict === "stop")
				return {
					met: false,
					exit: null,
					output: verdict.reason,
					refused: verdict.reason,
					...(verdict.spend ? { spend: verdict.spend } : {}),
				};
			return {
				met: verdict.verdict === "met",
				exit: null,
				output:
					verdict.verdict === "met"
						? `Judged met by ${verdict.model}: ${verdict.reason}`
						: `Judged ${verdict.verdict === "not_met" ? "not met" : "unsure"} by ${verdict.model}: ${verdict.reason}`,
				spend: verdict.spend,
			};
		},
		watch: (condition, env, poke, failed) =>
			base.hasWatch(condition.on) ? base.watch(condition.on, env, poke, failed) : () => undefined,
	};
}
