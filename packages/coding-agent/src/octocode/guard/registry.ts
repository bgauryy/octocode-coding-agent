import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { KIND_WORDS } from "./report.ts";
import type { GateResult } from "./store.ts";
import type { Review, ReviewKind } from "./types.ts";
import { visible } from "./visible.ts";

/**
 * What the loaders found this process, kind by kind: the reviews `/security`, `/harness` and the web list without loading
 * again, and the one start-up line. A loader replaces its kind's entry each time it runs (a reload, a new session).
 */

const SETTING: Record<ReviewKind, string> = { hook: "hooks", mcp: "mcp", skill: "skills" };

/** Whether `security.enforce` keeps unapproved items of `kind` off (the global setting; a project cannot change it). */
export function enforces(
	settings: { security?: { enforce?: readonly string[] } } | undefined,
	kind: ReviewKind,
): boolean {
	const enforce: readonly string[] = settings?.security?.enforce ?? SETTINGS_DEFAULTS.security.enforce;
	return enforce.includes(SETTING[kind]);
}

interface KindState {
	result: GateResult;
	enforced: boolean;
}

const found = new Map<ReviewKind, KindState>();

/** Records a loader's gate result for its kind. */
export function recordGate(kind: ReviewKind, result: GateResult, enforced: boolean): void {
	found.set(kind, { result, enforced });
}

/** Every review the loaders produced, by kind order. */
export function knownReviews(): Review[] {
	return (["hook", "mcp", "skill"] as const).flatMap((kind) => found.get(kind)?.result.reviews ?? []);
}

/** Whether a review's item is off because of the guard (enforced and not approved). */
export function isWithheld(review: Review): boolean {
	return review.word !== "approved" && found.get(review.item.kind)?.enforced === true;
}

/**
 * The start-up notices: each store fault and the count of what is off (warnings), and the one-time import (info).
 * Empty when there is nothing to say.
 */
export function guardNotices(): Array<{ text: string; level: "info" | "warning" }> {
	const states = [...found.values()];
	const withheld = knownReviews().filter(isWithheld);
	const off = withheld.length;
	const imported = states.reduce((sum, state) => sum + state.result.imported, 0);
	const notices: Array<{ text: string; level: "info" | "warning" }> = [];
	for (const state of states) if (state.result.warning) notices.push({ text: state.result.warning, level: "warning" });
	if (imported)
		notices.push({
			text: `Recorded ${imported} existing global item${imported === 1 ? "" : "s"} as approved (first run of the security review); /security lists them.`,
			level: "info",
		});
	if (off)
		notices.push({
			text: `${off} item${off === 1 ? " is" : "s are"} off until you check ${off === 1 ? "it" : "them"} in /security: ${withheldNames(withheld)}`,
			level: "warning",
		});
	return notices;
}

/** How many withheld items the start-up line names; the rest are counted. */
const NAMED_OFF = 3;

/** `MCP server demo, skill lint and 2 more`: the first withheld items by kind and name, so the line says what is off. */
function withheldNames(reviews: readonly Review[]): string {
	const names = reviews.slice(0, NAMED_OFF).map(({ item }) => `${KIND_WORDS[item.kind]} ${visible(item.label)}`);
	const more = reviews.length - names.length;
	return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}

/** Forgets everything recorded (tests). */
export function resetGateRecords(): void {
	found.clear();
}
