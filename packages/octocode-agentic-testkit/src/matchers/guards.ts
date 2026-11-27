import { callMatches } from "../guards.ts";
import { guardReason, type NamePattern } from "../trace.ts";
import { cannot, needTrace, type Result } from "./shared.ts";

export const guardMatchers = {
	/** A guard blocked a call the pattern names (any call without a pattern). */
	toHaveBlocked(received: unknown, pattern?: NamePattern): Result {
		const t = needTrace(received);
		const fired = t.of("guard");
		if (!t.probes.has("guards") && !fired.length)
			cannot("no guards on this trace (pass guards to startGateway, mockMcp or agentSuite)");
		const hit = fired.find(
			(e) =>
				pattern === undefined ||
				callMatches(pattern, { name: e.name ?? "", args: e.args, agent: e.agent, server: e.server }),
		);
		const seen = fired.map((e) => `#${e.seq} ${e.name}: ${guardReason(e)}`).join(" | ");
		const what = pattern === undefined ? "a call" : String(pattern);
		return {
			pass: hit !== undefined,
			message: () =>
				hit
					? `expected no guard to block ${what}; event #${hit.seq} blocked ${hit.name}`
					: `expected a guard to block ${what}; blocked: ${seen || "none"}`,
		};
	},
};
