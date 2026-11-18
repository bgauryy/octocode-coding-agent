/**
 * The summary of the coming threshold compaction, requested ahead while the run goes on.
 *
 * A compaction holds the turn while the model writes its summary. Shortly before the threshold the session fixes the
 * compaction's plan (its cut point) and tells features (`session_compact_prewarm`), which may request the summary
 * then. The threshold compaction that follows runs the same plan, so a summary that is ready is used at once and one
 * still being written is waited for only for what is left of it. Everything after the planned cut stays in the context
 * word for word, including what the run added in between.
 */

import type { Model } from "@octocodeai/octocode-ai/compat";
import {
	type CompactionPreparation,
	type CompactionSettings,
	fitCompactionToWindow,
	prepareCompaction,
	shouldCompact,
	type SummaryRequestPolicy,
} from "../compaction/index.ts";
import type { FeatureHost } from "../features/index.ts";
import type { SessionEntry, SessionManager } from "../session-manager.ts";

/** How far below the compaction threshold the plan is made: about the context a run adds while a summary is written. */
export function prewarmLeadTokens(contextWindow: number): number {
	return Math.min(32_000, Math.max(8_000, Math.floor(contextWindow / 10)));
}

interface Plan {
	preparation: CompactionPreparation;
	sessionId: string;
	/** The branch's last entry when the plan was made: the plan holds while the branch only grew past it. */
	leafId: string;
	target: string;
	controller: AbortController;
}

const targetOf = (model: Model<any>, settings: CompactionSettings, forced?: string): string =>
	JSON.stringify([
		model.provider,
		model.id,
		model.contextWindow,
		settings.reserveTokens,
		settings.keepRecentTokens,
		forced,
	]);

export class CompactionPrewarm {
	/** The plan in force: one is made, then kept until it is used, dropped or a compaction succeeds. */
	private plan: Plan | undefined;

	/** Whether `tokens` is inside the lead before the threshold of `model`'s window. */
	due(tokens: number, model: Model<any>, settings: CompactionSettings): boolean {
		const window = model.contextWindow;
		if (this.plan || !settings.enabled || !(window > 0)) return false;
		if (shouldCompact(tokens, window, settings)) return false;
		return tokens > window - settings.reserveTokens - prewarmLeadTokens(window);
	}

	/** Fixes the plan for the branch as it is now and tells features; does nothing when nothing can be summarized. */
	start(
		sessionManager: SessionManager,
		runner: FeatureHost,
		model: Model<any>,
		settings: CompactionSettings,
		summaryRequest: SummaryRequestPolicy,
	): void {
		if (this.plan || !runner.hasHandlers("session_compact_prewarm")) return;
		const branchEntries = sessionManager.getBranch();
		const leaf = branchEntries[branchEntries.length - 1];
		let preparation: CompactionPreparation | undefined;
		try {
			const prepared = prepareCompaction(branchEntries, settings);
			preparation = prepared && fitCompactionToWindow(branchEntries, prepared, model.contextWindow);
		} catch {
			// The kept part does not fit the window: the compaction itself reports that.
		}
		if (!preparation || !leaf) return;
		const controller = new AbortController();
		this.plan = {
			preparation,
			sessionId: sessionManager.getSessionId(),
			leafId: leaf.id,
			target: targetOf(model, settings, summaryRequest.forceSystemPrompt),
			controller,
		};
		// Not awaited: the request it starts runs beside the turn. A failing handler leaves the plan without a summary,
		// and the compaction then requests one as it always did.
		void runner
			.emit({ type: "session_compact_prewarm", preparation, branchEntries, signal: controller.signal, summaryRequest })
			.catch(() => undefined);
	}

	/**
	 * The plan's preparation when it still fits `branchEntries` (same session, model and settings, the branch grew past
	 * the plan's leaf without another compaction or context edit); otherwise the plan is dropped and undefined returned.
	 */
	take(
		branchEntries: readonly SessionEntry[],
		sessionId: string,
		model: Model<any>,
		settings: CompactionSettings,
		forcedSystemPrompt?: string,
	): CompactionPreparation | undefined {
		const plan = this.plan;
		if (!plan) return undefined;
		const leafAt = branchEntries.findIndex((entry) => entry.id === plan.leafId);
		const holds =
			plan.sessionId === sessionId &&
			plan.target === targetOf(model, settings, forcedSystemPrompt) &&
			leafAt >= 0 &&
			!plan.controller.signal.aborted &&
			branchEntries.some((entry) => entry.id === plan.preparation.firstKeptEntryId) &&
			!branchEntries.slice(leafAt + 1).some((entry) => entry.type === "compaction" || entry.type === "context_edit");
		if (!holds) {
			this.drop();
			return undefined;
		}
		return plan.preparation;
	}

	/** Ends the plan and its request. The next approach to the threshold plans again. */
	drop(): void {
		this.plan?.controller.abort();
		this.plan = undefined;
	}

	/** A compaction succeeded: its plan is over. */
	reset(): void {
		this.drop();
	}

	/** Ends a plan made for another model or other settings, so the request that follows plans for the ones in use. */
	dropIfStale(model: Model<any>, settings: CompactionSettings, forcedSystemPrompt?: string): void {
		if (this.plan && this.plan.target !== targetOf(model, settings, forcedSystemPrompt)) this.drop();
	}
}
