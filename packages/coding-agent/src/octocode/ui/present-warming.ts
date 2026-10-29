import { CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS } from "../../core/cache-warmer/economics.ts";
import type { ExtensionAPI } from "../../core/extensions/index.ts";

/** Whether the user is at the terminal, as the notifier sees it (focus reports, else keypresses). */
export interface Presence {
	/** True or false from the terminal's focus reports; undefined when it sends none. */
	focused(): boolean | undefined;
	/** When the user last pressed a key in the TUI. */
	lastInputAt(): number;
}

/** A keypress this recent counts as the user being at the terminal. */
const PRESENT_INPUT_MS = 2 * 60_000;

/**
 * Chance that a user who is visibly at the terminal (focused, or typing) sends the next request before the history cache
 * entry expires. An assumption, not a measurement: above the warmer's idle estimate, which covers every idle gap,
 * including users who left.
 */
export const PRESENT_CONTINUATION_PROBABILITY = 0.5;

/**
 * Idle cache warming with the user's presence: while the terminal is focused or the user typed recently, a refresh is
 * priced with {@link PRESENT_CONTINUATION_PROBABILITY} instead of the warmer's estimate. Otherwise the warmer decides.
 */
export function registerPresentWarming(api: ExtensionAPI, presence: Presence, now: () => number = Date.now): void {
	api.on("cache_warming_decision", async (event) => {
		// A running agent already counts as continuing; only idle refreshes estimate the user.
		if (event.continuationProbability >= PRESENT_CONTINUATION_PROBABILITY) return undefined;
		const present = presence.focused() === true || now() - presence.lastInputAt() < PRESENT_INPUT_MS;
		if (!present) return undefined;
		const savings = PRESENT_CONTINUATION_PROBABILITY * event.missCost - event.warmCost;
		return { action: savings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop" };
	});
}
