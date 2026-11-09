/** The one-line hint a tool call shows in the working line and activity. */
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { clipText, firstLine } from "../../../common/src/clip.ts";
import { redactSecrets } from "../../../common/src/sanitize.ts";

/**
 * The most telling argument of a tool call (path, command, query, url or element ref; else a plan's step sequence, a
 * CDP method, a recipe or a target), one clipped line. It is drawn in
 * the working line and stored as the agent's activity, which other sessions see: typed text is never used, URL
 * credentials are dropped and anything that looks like a secret is redacted.
 */
export function toolHint(args: unknown): string {
	const input = asRecord(args);
	const scalar = [input.path, input.command, input.query, input.url, input.ref].find(
		(value) => typeof value === "string",
	);
	const hint = scalar === undefined ? shapeHint(input) : input.headless === true ? `${scalar} (headless)` : scalar;
	if (!hint) return "";
	const line = firstLine(hint).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1");
	return clipText(redactSecrets(line), 80);
}

/** One plan step as `op` or `action target`; typed text and values are never named. */
function stepHint(step: unknown): string {
	const input = asRecord(step);
	const name = input.op === "act" && typeof input.action === "string" ? input.action : input.op;
	if (typeof name !== "string") return "";
	const target = [input.ref, input.selector].find((value) => typeof value === "string");
	return target === undefined ? name : `${name} ${target}`;
}

/** The hint for a call with no path, command, query, url or ref: the step sequence of its plan or step, else its CDP method, recipe or target. */
function shapeHint(input: Record<string, unknown>): string | undefined {
	const planned = asRecord(input.plan).steps;
	const steps = [...(Array.isArray(planned) ? planned : []), input.step];
	const sequence = steps.map(stepHint).filter(Boolean).join(" → ");
	if (sequence) return sequence;
	return [input.method, input.recipe, input.target, input.selector].find((value) => typeof value === "string");
}
