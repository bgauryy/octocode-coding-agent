import { matchName, type NamePattern, type TraceEvent } from "../trace.ts";
import { cannot, needTrace, sameValue, subset, type Result } from "./shared.ts";

/** A tool name pattern (exact, `*` glob or RegExp), optionally with the args the call must carry. */
export type TrajectoryStep = NamePattern | { tool: NamePattern; args?: Record<string, unknown> };

export interface TrajectoryOptions {
	/**
	 * `strict` (default): same calls, same order. `ordered`: the steps appear in this order, extra calls anywhere.
	 * `unordered`: same multiset. `superset`: extra calls allowed. `subset`: no call outside the steps.
	 */
	mode?: "strict" | "ordered" | "unordered" | "subset" | "superset";
	/** `subset` (default): expected args are contained in the actual args. `exact`: equal, key order aside. `ignore`: name only. */
	args?: "subset" | "exact" | "ignore";
	agent?: string;
}

interface Step {
	tool: NamePattern;
	args?: Record<string, unknown>;
}

const norm = (s: TrajectoryStep): Step => (typeof s === "string" || s instanceof RegExp ? { tool: s } : s);
const show = (s: Step, withArgs: boolean): string =>
	withArgs && s.args !== undefined ? `${String(s.tool)}(${JSON.stringify(s.args)})` : String(s.tool);

/** Whether `want` occurs in `have` as a subsequence; the earliest match for each step is optimal. */
function inOrder(want: Step[], have: TraceEvent[], same: (w: Step, h: TraceEvent) => boolean): boolean {
	let i = 0;
	for (const h of have) if (i < want.length && same(want[i], h)) i++;
	return i === want.length;
}

/** Whether `maxMatches` of the wanted steps can be assigned to distinct actual calls (augmenting-path matching). */
function assign(want: Step[], have: TraceEvent[], same: (w: Step, h: TraceEvent) => boolean): number {
	const owner = Array.from({ length: have.length }, () => -1);
	const tryWant = (w: number, seen: Set<number>): boolean => {
		for (let h = 0; h < have.length; h++) {
			if (seen.has(h) || !same(want[w], have[h])) continue;
			seen.add(h);
			if (owner[h] < 0 || tryWant(owner[h], seen)) {
				owner[h] = w;
				return true;
			}
		}
		return false;
	};
	return want.filter((_, w) => tryWant(w, new Set())).length;
}

export const trajectoryMatchers = {
	toFollowTrajectory(received: unknown, steps: TrajectoryStep[], o: TrajectoryOptions = {}): Result {
		const t = needTrace(received);
		const mode = o.mode ?? "strict";
		const argMode = o.args ?? "subset";
		const actual = t.events.filter(
			(e) => e.kind === "model_tool_call" && (o.agent === undefined || e.agent === o.agent),
		);
		if (!actual.length && !t.requests.length) return cannot("no model tool calls and no requests in the trace");
		const want = steps.map(norm);
		const same = (w: Step, h: TraceEvent): boolean =>
			matchName(w.tool, h.name) &&
			(argMode === "ignore" ||
				w.args === undefined ||
				(argMode === "exact" ? sameValue(w.args, h.args ?? {}) : subset(h.args ?? {}, w.args)));
		let pass: boolean;
		if (mode === "strict") pass = want.length === actual.length && want.every((w, i) => same(w, actual[i]));
		else if (mode === "ordered") pass = inOrder(want, actual, same);
		else if (mode === "unordered") pass = want.length === actual.length && assign(want, actual, same) === want.length;
		else if (mode === "superset") pass = assign(want, actual, same) === want.length;
		else pass = actual.every((h) => want.some((w) => same(w, h)));
		const withArgs = argMode !== "ignore";
		return {
			pass,
			message: () =>
				`${pass ? "expected the trajectory not to match" : "trajectory does not match"} (mode ${mode}, args ${argMode}${o.agent ? `, agent ${o.agent}` : ""})` +
				`\n  expected: ${want.map((s) => show(s, withArgs)).join(" -> ") || "none"}` +
				`\n  actual:   ${actual.map((e) => `${e.name}(${JSON.stringify(e.args ?? {})})`).join(" -> ") || "none"}`,
		};
	},
};
