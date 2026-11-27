import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { decide, type Decision, type LiveSummary } from "../../src/live.ts";

export interface SkillRow {
	fire?: LiveSummary;
	/** `successes` counts trials where the near-miss did NOT load the skill. */
	nearMiss?: LiveSummary;
	/** Trials that ended in a transport error (timeout, 429, 5xx), included in `failures` of the summary. */
	fireErrors?: number;
	nearMissErrors?: number;
	loadedOnFire?: string[];
}
export interface TierResult {
	model?: string;
	skills: Record<string, SkillRow>;
}

export type Verdict = "ok" | "description problem" | "small-model limit" | "over-broad" | "model-specific" | "no data";

/** A verdict needs this many answered (non-error) trials per tier. */
export const MIN_ANSWERED = 3;

interface Answered {
	successes: number;
	trials: number;
	errors: number;
	decision: Decision;
}

/** The summary without transport errors: errors are neither a fire nor a miss. */
function answered(s: LiveSummary | undefined, errors = 0): Answered | undefined {
	if (!s) return undefined;
	// Newer summaries count errors apart (`s.errors`); older ones folded them into failures.
	const trials = s.errors === undefined ? s.trials - errors : s.trials;
	return {
		successes: s.successes,
		trials,
		errors,
		decision: decide(s.successes, trials - s.successes, s.threshold, 0.9),
	};
}
const fireOf = (r?: SkillRow): Answered | undefined => answered(r?.fire, r?.fireErrors);
const missOf = (r?: SkillRow): Answered | undefined => answered(r?.nearMiss, r?.nearMissErrors);
const enough = (a: Answered | undefined): a is Answered => (a?.trials ?? 0) >= MIN_ANSWERED;
const fireRate = (r?: SkillRow): number | undefined => {
	const a = fireOf(r);
	return enough(a) ? a.successes / a.trials : undefined;
};
const missFireRate = (r?: SkillRow): number | undefined => {
	const a = missOf(r);
	return enough(a) ? 1 - a.successes / a.trials : undefined;
};
/** true/false once the tier answered enough trials; undefined when it did not (errors or no run). */
const fires = (r?: SkillRow): boolean | undefined => {
	const a = fireOf(r);
	return enough(a) ? a.decision === "pass" : undefined;
};

/**
 * Classify one skill across tiers (`small` is the weakest model, `strong` the rest, cheapest strong model first).
 * A tier without enough answered trials is ignored.
 * over-broad: a near-miss fires at least half the time on a strong tier.
 * description problem: the small model and every strong tier miss, and the first strong tier (Haiku) has data.
 * small-model limit: only the small model misses the should-fire prompt, or only it fires on the near-miss.
 * model-specific: other splits.
 */
export function classify(small: SkillRow | undefined, strong: (SkillRow | undefined)[]): Verdict {
	const strongRows = strong.filter((r) => r !== undefined);
	if (strongRows.some((r) => (missFireRate(r) ?? 0) >= 0.5)) return "over-broad";
	const smallFires = fires(small);
	const strongFires = strongRows.map(fires).filter((x): x is boolean => x !== undefined);
	if (smallFires === undefined && !strongFires.length) return "no data";
	if (strongFires.length === 0) return "no data";
	if (strongFires.every((x) => !x) && fires(strong[0]) === false && smallFires !== true) return "description problem";
	if (strongFires.every(Boolean)) {
		if (smallFires === false || (missFireRate(small) ?? 0) >= 0.5) return "small-model limit";
		return smallFires === true ? "ok" : "no data";
	}
	return "model-specific";
}

const pct = (x?: number): string => (x === undefined ? "-" : `${Math.round(x * 100)}%`);
const cell = (r?: SkillRow): string => {
	const a = fireOf(r);
	if (!a) return "-";
	if (a.trials < MIN_ANSWERED) return `error (${a.trials} answered)`;
	return `${pct(fireRate(r))} (${a.successes}/${a.trials}) ${a.decision}`;
};
const missCell = (r?: SkillRow): string => {
	const a = missOf(r);
	if (!a) return "-";
	if (a.trials < MIN_ANSWERED) return `error (${a.trials} answered)`;
	return `${pct(missFireRate(r))} ${a.decision}`;
};
const errCell = (r?: SkillRow): string => String((r?.fireErrors ?? 0) + (r?.nearMissErrors ?? 0));

/** Markdown comparison of tiers in column order; the first tier is the small-model baseline. */
export function compareTable(tiers: { name: string; result?: TierResult }[]): string {
	const names = [...new Set(tiers.flatMap((t) => Object.keys(t.result?.skills ?? {})))].sort();
	const [small, ...strong] = tiers;
	const head = [
		...tiers.map((t) => `${t.name} fire`),
		...tiers.map((t) => `${t.name} near-miss fires`),
		...tiers.map((t) => `${t.name} errors`),
	];
	const lines = [`| skill | ${head.join(" | ")} | verdict |`, `| --- | ${head.map(() => "---").join(" | ")} | --- |`];
	const counts = new Map<Verdict, number>();
	for (const n of names) {
		const rows = tiers.map((t) => t.result?.skills[n]);
		const v = classify(rows[0], rows.slice(1));
		counts.set(v, (counts.get(v) ?? 0) + 1);
		lines.push(
			`| ${n} | ${rows.map(cell).join(" | ")} | ${rows.map(missCell).join(" | ")} | ${rows.map(errCell).join(" | ")} | ${v} |`,
		);
	}
	const summary = [...counts].map(([v, c]) => `${v}: ${c}`).join(", ");
	return [
		`Fire = skill loaded on the should-fire prompt (rate, trials, decision at P(rate>0.5)); near-miss fires = rate the skill loaded on the near-miss prompt (lower is better).`,
		`Baseline tier: ${small?.name}; compared against ${strong.map((s) => s.name).join(", ")}.`,
		"",
		...lines,
		"",
		`Verdicts: ${summary}.`,
	].join("\n");
}

/** Read the per-tier JSON under `<root>/.octocode/tmp` and write `<root>/.octocode/agentic-testkit/triggers-compare.md`. */
export function writeComparison(root: string): string {
	const tmp = join(root, ".octocode/tmp");
	const load = (f: string): TierResult | undefined =>
		existsSync(join(tmp, f)) ? (JSON.parse(readFileSync(join(tmp, f), "utf8")) as TierResult) : undefined;
	const out = join(root, ".octocode/agentic-testkit/triggers-compare.md");
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(
		out,
		`# Skill trigger comparison\n\n${compareTable([
			{ name: "bonsai", result: load("skill-triggers.json") },
			{ name: "haiku", result: load("skill-triggers-haiku.json") },
			{ name: "deepseek", result: load("skill-triggers-deepseek.json") },
		])}\n`,
	);
	return out;
}
