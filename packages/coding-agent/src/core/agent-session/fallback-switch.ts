/**
 * A `retry.fallbackModels` switch, in the two forms it leaves: the one notice people read (the run warning in print
 * mode, the notification in interactive and RPC clients) and the session entry a parent reads from its child.
 */

import type { ProviderPlan } from "@octocodeai/octocode-ai";

type Billing = ProviderPlan["billing"];

/** The custom session entry a fallback switch appends (`FallbackSwitch` as its data); a child sends it as `entry_appended`. */
export const FALLBACK_ENTRY = "octocode-fallback";

/** What a parent learns about its child's switch. Machine fields: change them only with `subagents/event-ran.ts`. */
export interface FallbackSwitch {
	/** `provider/id` of the model that failed. */
	from: string;
	/** `provider/id` of the model the session continued on. */
	to: string;
	/** Why: `hit a usage limit`, `refused the credential`, `was unavailable for this account or endpoint`, `kept failing after retries`. */
	reason: string;
	/** One of the two is billed by plan and the other per token. */
	billingChanged: boolean;
}

/** A switch and how each side's provider bills (`ModelRuntime.getProviderBilling`). */
export interface FallbackFacts {
	from: string;
	to: string;
	reason: string;
	billing: { from: Billing; to: Billing };
}

/** `billed by plan` or `billed per token`. */
export const billedText = (billing: Billing): string => (billing === "plan" ? "billed by plan" : "billed per token");

export function fallbackRecord({ from, to, reason, billing }: FallbackFacts): FallbackSwitch {
	return { from, to, reason, billingChanged: billing.from !== billing.to };
}

/** The one notice of a switch; it names a change between plan and per-token billing. */
export function fallbackNotice({ from, to, reason, billing }: FallbackFacts): string {
	const changed =
		billing.from === billing.to
			? ""
			: `, ${billedText(billing.to)} instead of ${billing.from === "plan" ? "by plan" : "per token"}`;
	return `${from} ${reason}; continuing on ${to}${changed} (retry.fallbackModels). /model switches back.`;
}
