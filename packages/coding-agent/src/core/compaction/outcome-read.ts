import { clip, plural } from "@octocodeai/octocode-common/clip";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { LIFTED_DETAILS } from "./ledger.ts";

/**
 * How a compaction went, as the user's surfaces and hooks read it from the compaction entry: the outcome the core
 * records (`core/compaction/outcome.ts`) and the carried rules the summary lifted (`core/compaction/ledger.ts`).
 */
export interface CompactionOutcome {
	tokensBefore: number | undefined;
	/** The context the next request sends, estimated when the entry was saved; absent in older entries. */
	estimatedTokensAfter: number | undefined;
	/** `threshold`, `overflow`, `user` or `agent`; absent in older entries. */
	trigger: string | undefined;
	/** Who wrote the focus the summary was given (`user` or `agent`); absent without one. */
	focusSource: string | undefined;
	/** Standing rules (`C…`) and decisions (`D…`) the summary lifted, with the summarizer's reason. */
	lifted: Array<{ id: string; text: string; reason: string }>;
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const count = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function compactionOutcome(entry: { tokensBefore?: unknown; details?: unknown }): CompactionOutcome {
	const details = asRecord(entry.details);
	const lifted = Array.isArray(details[LIFTED_DETAILS]) ? (details[LIFTED_DETAILS] as unknown[]) : [];
	return {
		tokensBefore: count(entry.tokensBefore),
		estimatedTokensAfter: count(details.estimatedTokensAfter),
		trigger: text(details.trigger),
		focusSource: text(asRecord(details.focus).source),
		lifted: lifted.flatMap((bullet) =>
			isRecord(bullet) && typeof bullet.id === "string" && typeof bullet.text === "string"
				? [{ id: bullet.id, text: bullet.text, reason: text(bullet.reason) ?? "" }]
				: [],
		),
	};
}

/** Bullets named in the line; the rest are counted. */
const LISTED = 3;
const BULLET_CHARS = 80;

/**
 * `Compaction lifted 1 rule: [C3] Never push to main (the user allowed it)`, or undefined when nothing was lifted. A
 * `C` bullet is a standing rule, a `D` bullet a decision.
 */
export function liftedLine(lifted: CompactionOutcome["lifted"]): string | undefined {
	if (lifted.length === 0) return undefined;
	const rules = lifted.filter((bullet) => bullet.id.startsWith("C")).length;
	const decisions = lifted.length - rules;
	const what = [rules > 0 ? plural(rules, "rule") : "", decisions > 0 ? plural(decisions, "decision") : ""]
		.filter(Boolean)
		.join(" and ");
	const named = lifted.slice(0, LISTED).map((bullet) => {
		const reason = bullet.reason.trim() ? ` (${clip(bullet.reason, BULLET_CHARS)})` : "";
		return `[${bullet.id}] ${clip(bullet.text, BULLET_CHARS)}${reason}`;
	});
	const more = lifted.length > LISTED ? `; ${lifted.length - LISTED} more` : "";
	return `Compaction lifted ${what}: ${named.join("; ")}${more}`;
}
