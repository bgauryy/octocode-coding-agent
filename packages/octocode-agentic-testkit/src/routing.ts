import { firstCallOnly, type Guard } from "./guards.ts";
import { skillOf } from "./matchers/skills.ts";
import { matchName, type NamePattern, type Trace } from "./trace.ts";

/** One prompt and the tool (or `skill:<name>`) the model should pick first; null: answer without a tool. */
export interface RoutingCase {
	prompt: string;
	expect: NamePattern | null;
}

export interface RoutingResult {
	prompt: string;
	expected: string | null;
	/** The model's first tool call (`skill:<name>` for a skill load), or null when it answered. */
	chose: string | null;
	correct: boolean;
}

export interface RoutingReport {
	accuracy: number;
	results: RoutingResult[];
	/** expected -> chosen -> count; "(none)" stands for no tool. */
	confusion: Record<string, Record<string, number>>;
}

/** The first routing decision on a trace: the first model tool call, a skill load named `skill:<name>`. */
export function firstChoice(trace: Trace): string | null {
	const first = trace.events.find((e) => e.kind === "model_tool_call");
	if (!first) return null;
	const skill = skillOf(first);
	return skill ? `skill:${skill}` : (first.name ?? null);
}

/**
 * Asks each prompt once and records only the model's first choice. `run` starts the harness on a gateway with the
 * given guards (they block every call, so nothing executes and a case costs about one model request) and returns
 * that gateway's trace. Cases run one after another.
 */
export async function probeRouting(
	cases: RoutingCase[],
	run: (prompt: string, guards: readonly Guard[]) => Promise<Trace>,
): Promise<RoutingReport> {
	const results: RoutingResult[] = [];
	for (const c of cases) {
		// oxlint-disable-next-line no-await-in-loop -- cases run one after another, as documented: one harness and its spend at a time
		const chose = firstChoice(await run(c.prompt, [firstCallOnly()]));
		const correct = c.expect === null ? chose === null : chose !== null && matchName(c.expect, chose);
		results.push({ prompt: c.prompt, expected: c.expect === null ? null : String(c.expect), chose, correct });
	}
	const confusion: RoutingReport["confusion"] = {};
	for (const r of results) {
		const key = r.expected ?? "(none)";
		const row = confusion[key] ?? {};
		const col = r.chose ?? "(none)";
		row[col] = (row[col] ?? 0) + 1;
		confusion[key] = row;
	}
	return { accuracy: results.filter((r) => r.correct).length / Math.max(1, results.length), results, confusion };
}
