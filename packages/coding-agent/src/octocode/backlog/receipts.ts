import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import type { Completion } from "@octocodeai/octocode-contracts/backlogs";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { currentMutationRevision, mutationEpoch } from "../files/feedback/revisions.ts";
import { receiptId } from "../files/bash/verification.ts";

export type CompletionReceipt = NonNullable<Completion["receipt"]>;

/** The reference that names the newest receipt of this session, for a model that was not shown an id. */
const LATEST_RECEIPT = "latest";

/** Marks the note a skipped QA review leaves; a completion written with it records `qa: skipped`. */
export const QA_SKIPPED_PREFIX = "QA skipped:";

const QA_SKIPPED = new RegExp(`^${QA_SKIPPED_PREFIX}`, "m");

/** Finds a receipt by a reference (an id or `latest`) among this session's saved bash results; throws when none resolves. */
export type ReceiptLookup = (ref: string) => CompletionReceipt;

interface Entry {
	type: string;
	message?: unknown;
}

const STATES = new Set(["running", "finished", "failed", "stopped"]);

/** The receipt a saved `bash` result holds in `details.verification`, or undefined when it holds none. */
function receiptOf(entry: Entry): Record<string, unknown> | undefined {
	const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
	if (message?.role !== "toolResult" || message.toolName !== "bash" || !isRecord(message.details)) return undefined;
	const receipt = message.details.verification;
	return isRecord(receipt) &&
		typeof receipt.command === "string" &&
		typeof receipt.sessionId === "string" &&
		typeof receipt.startedAt === "number" &&
		typeof receipt.mutationEpoch === "string" &&
		typeof receipt.revisionAtLaunch === "number" &&
		typeof receipt.state === "string" &&
		STATES.has(receipt.state)
		? receipt
		: undefined;
}

/** The receipt's facts as they stand now: stale also when a later edit or another process has moved the workspace on. */
function facts(receipt: Record<string, unknown>): CompletionReceipt {
	const sessionId = receipt.sessionId as string;
	const revisionAtLaunch = receipt.revisionAtLaunch as number;
	const mutationEpochSaved = receipt.mutationEpoch as string;
	return {
		id: receiptId({
			sessionId,
			startedAt: receipt.startedAt as number,
			command: receipt.command as string,
		}),
		// The board is exported and shown in the browser: keep secrets in the command out of it. The id hashes the original.
		command: redactSecrets(receipt.command as string),
		state: receipt.state as CompletionReceipt["state"],
		...(typeof receipt.exitCode === "number" || receipt.exitCode === null ? { exitCode: receipt.exitCode } : {}),
		stale:
			receipt.stale === true ||
			mutationEpochSaved !== mutationEpoch ||
			currentMutationRevision(sessionId) !== revisionAtLaunch,
		mutationEpoch: mutationEpochSaved,
		revisionAtLaunch,
		...(typeof receipt.revisionAtCompletion === "number" ? { revisionAtCompletion: receipt.revisionAtCompletion } : {}),
	};
}

/** A lookup over `entries`, the saved entries of this session's branch; a newer result of the same receipt wins. */
export function receiptLookup(entries: () => readonly Entry[]): ReceiptLookup {
	return (ref) => {
		const wanted = ref.trim();
		let found: Record<string, unknown> | undefined;
		for (const entry of entries()) {
			const receipt = receiptOf(entry);
			if (!receipt) continue;
			if (wanted === LATEST_RECEIPT || receiptId(receipt as never) === wanted) found = receipt;
		}
		if (!found)
			throw new Error(
				wanted === LATEST_RECEIPT
					? "completion.receipt: this session has no bash result with a receipt; run the check with verify: true first."
					: `completion.receipt ${wanted} is not a receipt of this session: use the id a verify: true bash result printed, or "${LATEST_RECEIPT}".`,
			);
		return facts(found);
	};
}

/** The indicator a reader sees beside a completion's verification: what the evidence says about the command, never that the goal is met. */
export type EvidenceIndicator = "Recorded check" | "Reported" | "Skipped" | "Stale";

export function evidenceIndicator(completion: Pick<Completion, "receipt" | "qa">): EvidenceIndicator {
	const { receipt } = completion;
	if (receipt)
		return receipt.stale
			? "Stale"
			: receipt.state === "finished" && receipt.exitCode === 0
				? "Recorded check"
				: "Reported";
	return completion.qa === "skipped" ? "Skipped" : "Reported";
}

/** One line for the indicator and, with a receipt, the command and its exit. */
export function evidenceLine(completion: Pick<Completion, "receipt" | "qa">): string {
	const { receipt } = completion;
	const label = evidenceIndicator(completion);
	if (!receipt) return `Evidence: ${label}${label === "Skipped" ? " (QA did not run)" : " (text only)"}`;
	const exit = receipt.exitCode === undefined ? receipt.state : `exit ${receipt.exitCode}`;
	return `Evidence: ${label} (${receipt.id}: ${receipt.command}; ${exit}${receipt.stale ? "; later edits or another process" : ""})`;
}

/**
 * The completion with its cited receipt resolved to facts and its QA outcome recorded. A retry of a completion already
 * written keeps the facts it was written with, so it replays instead of conflicting with a check that has since gone stale.
 */
export function withEvidence<C extends { operationKey: string; receipt?: unknown }>(
	completion: C,
	lookup: ReceiptLookup | undefined,
	note: string | undefined,
	written: readonly Pick<Completion, "operationKey" | "receipt" | "qa">[] | undefined,
): Omit<C, "receipt"> & Pick<Completion, "receipt" | "qa"> {
	const { receipt: cited, ...rest } = completion;
	const previous = written?.find((done) => done.operationKey === completion.operationKey);
	if (previous)
		return {
			...rest,
			...(previous.receipt ? { receipt: previous.receipt } : {}),
			...(previous.qa ? { qa: previous.qa } : {}),
		};
	if (cited !== undefined && typeof cited !== "string")
		throw new Error('completion.receipt must be a receipt id or "latest".');
	if (cited !== undefined && !lookup)
		throw new Error("completion.receipt needs the session that ran the check: cite it from that session.");
	return {
		...rest,
		...(cited !== undefined && lookup ? { receipt: lookup(cited) } : {}),
		...(note && QA_SKIPPED.test(note) ? { qa: "skipped" as const } : {}),
	};
}
