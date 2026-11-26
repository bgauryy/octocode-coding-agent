import { inputRoomTokens } from "../../core/compaction/settings.ts";
import type { Api, Model } from "@octocodeai/octocode-ai";
import { charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";
import { estimateTokens } from "../../core/compaction/index.ts";
import type { SetupPick, FeatureContext } from "../../core/features/index.ts";

/**
 * When compaction runs, beyond Octocode's threshold: a breaker for compactions that keep refilling the context, and a
 * compaction before a switch to a model whose window the context does not fit.
 */

/** A compaction this few turns after the previous one counts as a refill (a summary that freed room lasts longer than this)... */
export const THRASH_TURNS = 3;
/** ...and this many refills in a row stop automatic compaction: a single refill can be one big read, a streak is a loop. */
export const THRASH_STREAK = 3;

/** A compaction should leave the context at or below this share of the trigger, or the next one would follow at once. */
export const RECOVERY_BAND = 0.8;

/** Whether a compaction left `tokensAfter` within the recovery band of `trigger`; an unknown size counts as recovered. */
export function recoveredBelowBand(tokensAfter: number | undefined, trigger: number): boolean {
	return tokensAfter === undefined || tokensAfter <= RECOVERY_BAND * trigger;
}

/** Counts compactions that came right after the previous one. */
export class ThrashBreaker {
	#turnsSince: number | undefined;
	#streak = 0;
	#turnInRun = false;
	#poorRecovery = false;

	reset(): void {
		this.#turnsSince = undefined;
		this.#streak = 0;
		this.#turnInRun = false;
		this.#poorRecovery = false;
	}

	turnEnded(): void {
		this.#turnInRun = true;
		if (this.#turnsSince !== undefined) this.#turnsSince += 1;
	}

	/** A run settled; one that ended without a turn (its prompt was stopped before the request) counts as one turn. */
	runSettled(): void {
		if (!this.#turnInRun) this.turnEnded();
		this.#turnInRun = false;
	}

	get turnsSinceCompaction(): number | undefined {
		return this.#turnsSince;
	}

	/**
	 * Records a finished compaction; a manual one starts the count over. One at a finished item (`item`) is the
	 * harness's choice, not a refill: it restarts the turn count (the cooldown) and leaves the streak as it was.
	 * An automatic one that did not `recovered` (the context stayed above the recovery band) refuses the next within the
	 * refill window at once: a second summary of what is left would free little.
	 */
	compacted(manual: boolean, item = false, recovered = true): void {
		this.#poorRecovery = !manual && !item && !recovered;
		if (item) {
			this.#turnsSince = 0;
			return;
		}
		this.#streak = !manual && this.#turnsSince !== undefined && this.#turnsSince <= THRASH_TURNS ? this.#streak + 1 : 0;
		this.#turnsSince = 0;
	}

	/**
	 * Whether an automatic compaction now should be refused: the context refilled right away too many times, or (unless
	 * `ignoreBand`) the previous compaction left it above the recovery band. An overflow compaction is the only way to
	 * continue, so the band never refuses it; the compact tool has its own cooldown and floor.
	 */
	tripped(ignoreBand = false): boolean {
		return (
			((this.#poorRecovery && !ignoreBand) || this.#streak >= THRASH_STREAK) &&
			this.#turnsSince !== undefined &&
			this.#turnsSince <= THRASH_TURNS
		);
	}
}

export const THRASH_MESSAGE =
	`Automatic compaction stopped: the context refilled to the limit within ${THRASH_TURNS} turns of the previous compaction, ` +
	`${THRASH_STREAK} times in a row, so another summary would not make room. Something keeps adding more than the summary ` +
	"frees (a large file read, tool output or attachment). Start a new session, or reduce the large inputs before running /compact again.";

/**
 * Whether switching from `previous` to `next` needs a compaction first: the context (`tokens`) does not fit the new
 * window less the room Octocode keeps for a reply (`reserveTokens`), and the previous model could still read all of it.
 */
export function needsDownshiftCompaction(
	previous: Pick<Model<Api>, "contextWindow" | "inputLimits"> | undefined,
	next: Pick<Model<Api>, "contextWindow" | "inputLimits">,
	tokens: number | null | undefined,
	reserveTokens: number,
): boolean {
	if (!previous || tokens === null || tokens === undefined || next.contextWindow <= 0) return false;
	const available = inputRoomTokens(next.contextWindow, reserveTokens, next.inputLimits?.maxInputTokens);
	return (
		available < inputRoomTokens(previous.contextWindow, reserveTokens, previous.inputLimits?.maxInputTokens) &&
		tokens > available
	);
}

/** The characters of the tool definitions declared to the model (name, description, parameters, guidelines of the active tools). */
export function toolDefinitionChars(api: SetupPick<"tools", "getActive" | "getAll">): number {
	try {
		const active = new Set(api.tools.getActive());
		return api.tools.getAll().reduce((sum, tool) => {
			if (!active.has(tool.name)) return sum;
			const { name, description, parameters, promptGuidelines } = tool;
			return sum + JSON.stringify({ name, description, parameters, promptGuidelines }).length;
		}, 0);
	} catch {
		// An unserializable definition only lowers the estimate, which paces compaction and blocks nothing.
		return 0;
	}
}

/**
 * The context's size in tokens: Octocode's count, else (Octocode has none after a compaction until the next reply) an estimate of
 * what the next request carries: every message in the context by core's per-message estimate, which already counts the
 * system message's prompt and declared tools. Only what the transcript does not hold is added: the system prompt when no
 * system message is there, and the active tool definitions (`toolChars`) when none are declared. The estimate is at the
 * session model's tokenizer ratio, as the compaction trigger counts.
 */
export function contextTokens(
	ctx: Pick<FeatureContext, "getContextUsage" | "getSystemPrompt" | "sessionManager" | "model">,
	toolChars = 0,
): number | undefined {
	const tokens = ctx.getContextUsage()?.tokens;
	if (typeof tokens === "number") return tokens;
	try {
		const messages = ctx.sessionManager.buildSessionProjection().entries.flatMap((entry) => entry.messages);
		const system = messages.find((message) => message.role === "system");
		const declaresTools = system?.role === "system" && (system.toolsAdded?.length ?? 0) > 0;
		const fixed = charsToTokens(
			(system ? 0 : ctx.getSystemPrompt().length) + (declaresTools ? 0 : toolChars),
			ctx.model,
		);
		return fixed + messages.reduce((sum, message) => sum + estimateTokens(message, ctx.model), 0);
	} catch {
		// Unknown size: `needsDownshiftCompaction` then starts no compaction, and the model switch goes on.
		return undefined;
	}
}

/** Whether the context (by `contextTokens`) is known to fit the session's context window, so the next request can be sent. */
export function fitsWindow(
	ctx: Pick<FeatureContext, "getContextUsage" | "getSystemPrompt" | "sessionManager" | "model">,
	toolChars = 0,
): boolean {
	const window = ctx.getContextUsage()?.contextWindow ?? 0;
	const tokens = contextTokens(ctx, toolChars);
	return window > 0 && tokens !== undefined && tokens <= window;
}
