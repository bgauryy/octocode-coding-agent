import type { ProviderPlan, Usage } from "@octocodeai/octocode-ai";
import type { SessionEntry } from "./session-manager/types.ts";

/** Who pays for a request: `plan`, a subscription (its cost is an estimate at list price), or `metered` (money); the provider plan's `billing`. */
export type Billing = ProviderPlan["billing"];

/** One model request no session entry records in a form the capture reads (an external runner's turn, a prompt rewrite). */
interface SpendRequest {
	/** The workspace it was made for. */
	cwd: string;
	/** What it was for: `runner`, `prompt_rewrite`… */
	kind: string;
	provider: string;
	model: string;
	usage: Usage;
	/** Who paid, when the caller knows (a runner's sign-in); else the provider's billing now. */
	billing?: Billing | undefined;
}

/**
 * What this process does with spend as it happens. A session store calls `billing` and `appended` for each entry it
 * appends itself (`session-manager/persistence.ts`), never for records another process wrote and a merge read in, so
 * each model request is seen once, by the process that made it. The usage feature installs one (`octocode/usage/`).
 */
export interface SpendCapture {
	/** Who pays for the spend `entry` carries, resolved now; undefined for an entry that carries none. */
	billing(entry: SessionEntry): Billing | undefined;
	/** `entry`, carrying spend, joined a saved session working in `cwd`. */
	appended(entry: SessionEntry, cwd: string): void;
	/** A request whose spend no session entry carries. */
	spent(request: SpendRequest): void;
}

let active: SpendCapture | undefined;

/** Makes `capture` the process's; the returned function removes it unless another replaced it since. */
export function installSpendCapture(capture: SpendCapture): () => void {
	active = capture;
	return () => {
		if (active === capture) active = undefined;
	};
}

/**
 * Stores on `entry`, before it is written, who pays for the spend it carries (`SessionEntry.billing`): readers take it
 * from there instead of judging it again from the credentials of their own day. Nothing without a capture.
 */
export function stampSpendBilling(entry: SessionEntry): void {
	if (!active || entry.billing !== undefined) return;
	const billing = active.billing(entry);
	if (billing) entry.billing = billing;
}

/** Hands an appended entry of a saved session to the capture; an unsaved session's spend is not recorded. */
export function noteAppendedSpend(entry: SessionEntry, session: { persist: boolean; cwd: string }): void {
	if (active && session.persist && entry.billing !== undefined) active.appended(entry, session.cwd);
}

/** Records `request` (`SpendCapture.spent`); nothing without a capture. */
export function captureSpend(request: SpendRequest): void {
	active?.spent(request);
}
