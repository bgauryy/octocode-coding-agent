import { sameSecret } from "@octocodeai/octocode-common/env";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** The extension event a parent's relay publishes when a child reports what it read (`ChildExposure`). */
export const CHILD_EXPOSURE_EVENT = "octocode:child-exposure";

/** What that event carries: the child's name, from the process the message arrived on, and what the child said. */
export interface ChildExposure {
	child: string;
	exposed: boolean;
}

/** Starts the `notify` message a subagent's harness sends its parent about what it read (the rest is JSON). */
export const EXPOSURE_NOTIFY_PREFIX = "octocode-exposure/1 ";

/**
 * The `notify` message that tells a parent whether this subagent read any source a workspace read does not vouch for
 * (`Provenance.exposed`). It carries the child's nonce, like an audit entry: only the child's own harness can write it.
 */
export const exposureMessage = (exposed: boolean, nonce: string): string =>
	`${EXPOSURE_NOTIFY_PREFIX}${JSON.stringify({ exposed, nonce })}`;

/** What `message` says, or undefined when it is no exposure message or fails the nonce (an empty nonce never matches). */
export function parseExposure(message: string, nonce: string): boolean | undefined {
	if (nonce === "" || !message.startsWith(EXPOSURE_NOTIFY_PREFIX)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(message.slice(EXPOSURE_NOTIFY_PREFIX.length));
	} catch {
		return undefined;
	}
	if (!isRecord(raw) || !sameSecret(nonce, raw.nonce) || typeof raw.exposed !== "boolean") return undefined;
	return raw.exposed;
}
