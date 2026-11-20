import { renderPrompt } from "../../core/prompt-template.ts";
import type { SetupPick, FeatureContext } from "../../core/features/index.ts";
import type { CompactionEntry, SessionEntry } from "../../core/session-manager.ts";
import { CheckpointPersistenceError } from "../../core/compaction/index.ts";
import type { NativeCompactionResult } from "../../core/compaction/native-result.ts";
import { splitSummary } from "../../core/compaction/summary-view.ts";
import { UsagePersistenceError } from "../../core/usage-totals.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { BranchIndex, type BranchSource } from "../shared/branch-index.ts";
import { notify } from "../shared/commands.ts";
import { isStaleSessionError } from "../shared/util.ts";
import { recordCompactionNote } from "./record.ts";

/**
 * What code appends to every Octocode checkpoint (the saved-results block, the user's messages word for word within the
 * checkpoint's budgets, the Recovery section; `summary.ts`) when both of Octocode's summary requests failed and
 * Octocode's default summary was saved instead: the same sections, built before that summary (so a persistence failure
 * still fails the compaction, as it does for Octocode's own summary) and delivered after it as one hidden message, at
 * the end of the new context where no cached prefix changes. The next Octocode summary carries its user messages on
 * (`carriedUserMessages`), so they are kept once, never as a second copy.
 */

export const CONTINUITY_TYPE = "octocode-compaction-continuity";

/**
 * A checkpoint persistence failure (Octocode's summary or these sections) is not the user's cancel: the compaction fails,
 * and the automatic failure limit counts it. Undefined for any other error.
 */
export function persistenceFailure(
	api: SetupPick<"session", "appendEntry">,
	ctx: Pick<FeatureContext, "hasUI" | "ui">,
	error: unknown,
): NativeCompactionResult | undefined {
	if (!(error instanceof CheckpointPersistenceError || error instanceof UsagePersistenceError)) return undefined;
	recordCompactionNote(api, "checkpoint-not-saved", error.message);
	if (ctx.hasUI) notify(ctx.ui, error.message, "error");
	return { cancel: true, failure: error.message };
}

interface UserMessages {
	messages: string[];
	omitted: number;
}

/**
 * The user messages the previous checkpoint kept. After Octocode's default summary, the continuity message that followed
 * that compaction (its `compactionId` is the latest compaction's) holds them, whatever the default summary copied of
 * them; otherwise (Octocode's own summary, or no such message) the previous summary's own text (`previous`).
 */
export function carriedUserMessages(previous: UserMessages | undefined, branch: readonly SessionEntry[]): UserMessages {
	const at = branch.findLastIndex((entry) => entry.type === "compaction");
	const latest = at < 0 ? undefined : branch[at];
	const note =
		latest?.type !== "compaction" || latest.fromHook
			? undefined
			: branch
					.slice(at + 1)
					.find(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === CONTINUITY_TYPE &&
							isRecord(entry.details) &&
							entry.details.compactionId === latest.id,
					);
	if (note?.type !== "custom_message" || typeof note.content !== "string")
		return previous ?? { messages: [], omitted: 0 };
	const { messages, omitted } = splitSummary(note.content);
	return { messages, omitted };
}

function noteOf(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "custom" || message.customType !== CONTINUITY_TYPE) return undefined;
	return isRecord(message.details) && typeof message.details.compactionId === "string"
		? message.details.compactionId
		: undefined;
}

/** The latest compaction entry on a branch: a fold a request resumes, so it reads only the entries added since the last one. */
const latestCompactionIndex = new BranchIndex<{ entry?: CompactionEntry }>(
	() => ({}),
	(state, entry) => {
		if (isRecord(entry) && entry.type === "compaction") state.entry = entry as unknown as CompactionEntry;
	},
);

/** The latest compaction on the session's current branch, if any. */
export function latestCompaction(session: BranchSource): CompactionEntry | undefined {
	return latestCompactionIndex.read(session).entry;
}

/**
 * The request's messages without the continuity messages of earlier compactions that the latest compaction carried on.
 * A quick second compaction can keep the first one's continuity message in its retained tail, while its own summary
 * (`ownSummary`: Octocode's) or continuity message already carries that message's user messages and saved results
 * (`carriedUserMessages`, `carriedSavedResults`): shown both, the model would read each twice. After any other summary
 * (another feature's, or Octocode's default one without its continuity message) nothing carried them, so they stay.
 * Hiding them changes no prefix a provider can still reuse: the latest summary before them is new. Returns `messages`
 * itself when nothing is hidden.
 */
export function withoutCarriedNotes<T>(
	messages: T[],
	latestCompactionId: string | undefined,
	ownSummary: boolean,
): T[] {
	if (latestCompactionId === undefined) return messages;
	const carried = ownSummary || messages.some((message) => noteOf(message) === latestCompactionId);
	if (!carried) return messages;
	const kept = messages.filter((message) => {
		const id = noteOf(message);
		return id === undefined || id === latestCompactionId;
	});
	return kept.length === messages.length ? messages : kept;
}

/** The sections held for the compaction under way until its default summary is saved; one compaction at a time. */
export class FallbackContinuity {
	#pending: { firstKeptEntryId: string; text: string } | undefined;

	/** Holds the code sections (`text`, each starting with a blank line) for the compaction keeping from `firstKeptEntryId`. */
	hold(firstKeptEntryId: string, text: string): void {
		this.#pending = text ? { firstKeptEntryId, text } : undefined;
	}

	discard(): void {
		this.#pending = undefined;
	}

	/**
	 * After a compaction is saved: sends the held sections when `entry` is the default summary they were built for
	 * (Octocode's own summary and another feature's have `fromHook`). Returns whether it sent them; the sections already
	 * hold the archive pointer, so no separate pointer is needed then. Settles once the message is sent.
	 */
	async deliver(api: SetupPick<"session", "sendMessage">, entry: CompactionEntry): Promise<boolean> {
		const pending = this.#pending;
		this.#pending = undefined;
		if (!pending || entry.fromHook || entry.firstKeptEntryId !== pending.firstKeptEntryId) return false;
		try {
			await api.session.sendMessage(
				{
					customType: CONTINUITY_TYPE,
					content: `${renderPrompt("notices/compaction/default-summary.md")}${pending.text}`,
					display: false,
					details: { compactionId: entry.id },
				},
				{ triggerTurn: false },
			);
		} catch (error) {
			if (!isStaleSessionError(error)) throw error;
		}
		return true;
	}
}
