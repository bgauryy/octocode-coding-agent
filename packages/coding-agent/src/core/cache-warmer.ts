import { resolveCacheRetention, resolveInstructionCacheRetention } from "@octocodeai/octocode-ai/utils/cache-policy";
import {
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	estimateInstructionPrefixTokens,
	getCacheWarmingDelayMs,
	getPromptCacheLifetime,
	IDLE_CONTINUATION_PROBABILITY,
	isReplayable,
	lastPromptTokens,
	MAX_IDLE_WARMING_AGE_MS,
	MAX_WARMING_AGE_MS,
	price,
} from "./cache-warmer/economics.ts";
import type {
	ActiveRun,
	CacheWarmingAction,
	CacheWarmingDecision,
	CacheWarmingDecisionEvent,
	CacheWarmingStatus,
	CacheWarmRequest,
} from "./cache-warmer/types.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SessionManager, UsageEntry } from "./session-manager.ts";
import type { CacheWarmingMode } from "./settings-manager.ts";

export {
	getCacheWarmingDelayMs,
	getPromptCacheLifetime,
	getPromptCacheTtlMs,
	isReplayable,
} from "./cache-warmer/economics.ts";
export { formatCacheWarmingStatus, formatCacheWarmingUsage } from "./cache-warmer/format.ts";
export type {
	CacheWarmingAction,
	CacheWarmingDecision,
	CacheWarmingDecisionEvent,
	CacheWarmingDecisionEventResult,
	CacheWarmingStatus,
	CacheWarmRequest,
} from "./cache-warmer/types.ts";

/**
 * Keeps one prompt cache entry alive by re-sending its request with a
 * one-token output cap before the entry expires. `start` replaces any
 * previous run; warm requests never extend the fixed safety windows.
 */
export class CacheWarmer {
	private run?: ActiveRun;
	private inactive: CacheWarmingStatus;
	private readonly models: Pick<ModelRuntime, "streamSimple">;
	private readonly sessionManager: Pick<SessionManager, "captureUsageWriter" | "getSessionId" | "getBranch">;
	private readonly getMode: () => CacheWarmingMode;
	/** Lets extensions override `event.action`; failures fall back to Octocode's decision. */
	private readonly decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction>;
	/** Called with the persisted usage entry after each successful refresh. */
	onWarmed?: (entry: UsageEntry) => void;

	constructor(
		models: Pick<ModelRuntime, "streamSimple">,
		sessionManager: Pick<SessionManager, "captureUsageWriter" | "getSessionId" | "getBranch">,
		getMode: () => CacheWarmingMode,
		decide: (event: CacheWarmingDecisionEvent) => Promise<CacheWarmingAction> = async (event) => event.action,
	) {
		this.models = models;
		this.sessionManager = sessionManager;
		this.getMode = getMode;
		this.decide = decide;
		this.inactive = { state: "inactive", reason: "waiting for first request" };
	}

	get status(): CacheWarmingStatus {
		if (this.getMode() === "off") return { state: "inactive", reason: "cache warming disabled" };
		const run = this.run;
		if (!run) return this.inactive;
		if (!run.isCurrent()) return { state: "inactive", reason: "conversation context changed" };
		const decision = this.evaluate(run);
		const refreshing = run.timer === undefined;
		if (!decision.economicsAvailable && !refreshing) {
			return { state: "inactive", reason: "cache economics unavailable" };
		}
		return {
			state: refreshing ? "refreshing" : "scheduled",
			nextWarmAt: run.nextWarmAt,
			decision,
			extensionOverride: run.extensionOverride,
		};
	}

	/** Keep the prompt cache entry written by `request` warm while `isCurrent` holds. */
	start(request: CacheWarmRequest, isCurrent: () => boolean): void {
		this.clearRun();
		const mode = this.getMode();
		if (mode === "off") {
			this.stop("cache warming disabled");
			return;
		}
		if (!isReplayable(request.model, request.options)) {
			this.stop("request cannot be replayed safely");
			return;
		}
		const options = {
			...request.options,
			cacheRetention: resolveCacheRetention(request.options.cacheRetention, request.options.env),
			instructionCacheRetention: resolveInstructionCacheRetention(request.options),
		};
		const lifetime = getPromptCacheLifetime(request.model, options);
		if (lifetime === undefined) {
			this.stop(
				request.options.cacheRetention === "none" ? "request disabled prompt caching" : "cache lifetime unavailable",
			);
			return;
		}
		const { ttlMs, layered } = lifetime;
		const delayMs = getCacheWarmingDelayMs(ttlMs);
		if (delayMs === undefined) {
			this.stop("cache lifetime unavailable");
			return;
		}
		this.run = {
			...request,
			options,
			isCurrent,
			ttlMs,
			instructionTokens: layered ? estimateInstructionPrefixTokens(request.context) : 0,
			delayMs,
			refreshDeadlineAt: 0,
			startedAt: Date.now(),
			controller: new AbortController(),
			phase: "streaming",
			nextWarmAt: 0,
			extensionOverride: false,
		};
		this.schedule(this.run);
	}

	onAgentSettled(): void {
		const run = this.run;
		if (!run) return;
		if (this.getMode() === "streaming") {
			this.stop("agent run settled");
			return;
		}
		run.phase = "idle";
		const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop("30-minute idle safety limit reached");
		}
	}

	/** Reconcile an active run after the persisted warming mode changes. */
	onModeChanged(): void {
		const run = this.run;
		if (!run) return;
		const reason = this.getModeStopReason(run);
		if (reason) this.stop(reason);
	}

	cancel(): void {
		this.stop("inactive");
	}

	private clearRun(): void {
		const run = this.run;
		if (!run) return;
		this.run = undefined;
		if (run.timer) clearTimeout(run.timer);
		run.controller.abort();
	}

	private stop(reason: string, stopped?: Pick<CacheWarmingStatus, "decision" | "extensionOverride">): void {
		this.clearRun();
		this.inactive = { state: "inactive", reason, ...stopped };
	}

	private schedule(run: ActiveRun, refreshedAt = Date.now()): void {
		run.extensionOverride = false;
		run.nextWarmAt = refreshedAt + run.delayMs;
		// A timer can run late after sleep or event-loop blockage. Keep half of
		// the planned pre-expiry margin for that delay and request dispatch; a
		// late refresh is likely a full-price cache write, not a cache warm.
		run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
		if (this.refreshDeadlineMissed(run)) return;
		const deadline = run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
		if (run.nextWarmAt > deadline || Date.now() >= deadline) {
			this.stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
			return;
		}
		run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()));
		run.timer.unref?.();
	}

	private async refresh(run: ActiveRun): Promise<void> {
		run.timer = undefined;
		if (!this.validateRun(run)) return;
		if (this.refreshDeadlineMissed(run)) return;
		let decision: CacheWarmingDecision;
		let action: CacheWarmingAction;
		// The agent can settle while an extension is deciding. Its idle probability
		// changes the economics, so send a fresh decision for the new phase.
		while (true) {
			decision = this.evaluate(run);
			action = decision.action;
			try {
				action = await this.decide({
					type: "cache_warming_decision",
					warmCost: decision.warmCost,
					missCost: decision.missCost,
					continuationProbability: decision.continuationProbability,
					action,
				});
			} catch {
				// Extension failures fall back to the current economic decision.
			}
			if (!this.validateRun(run) || this.refreshDeadlineMissed(run)) return;
			if (decision.phase === run.phase) break;
		}
		const extensionOverride = action !== decision.action;
		if (action === "stop") {
			const reason = extensionOverride
				? "stopped by extension"
				: decision.economicsAvailable
					? "expected savings below threshold"
					: "cache economics unavailable";
			this.stop(reason, { decision, extensionOverride });
			return;
		}

		run.extensionOverride = extensionOverride;
		const appendUsage = this.sessionManager.captureUsageWriter();
		const sessionId = this.sessionManager.getSessionId();
		const refreshedAt = Date.now();
		try {
			const message = await this.models
				.streamSimple(run.model, run.context, {
					...run.options,
					maxTokens: 1,
					maxRetries: 0,
					signal: run.controller.signal,
				})
				.result();
			const succeeded = message.stopReason !== "error" && message.stopReason !== "aborted";
			const hasUsage = [
				message.usage.input,
				message.usage.output,
				message.usage.cacheRead,
				message.usage.cacheWrite,
				message.usage.totalTokens,
				message.usage.cost.total,
			].some((value) => value > 0);
			if (succeeded || hasUsage) {
				const note =
					[extensionOverride ? "extension override" : "", succeeded ? "" : message.stopReason]
						.filter(Boolean)
						.join(", ") || undefined;
				const entry = appendUsage(
					"cache_warm",
					message.provider,
					message.responseModel ?? message.model,
					message.usage,
					note,
					refreshedAt,
				);
				if (this.sessionManager.getSessionId() === sessionId) this.onWarmed?.(entry);
			}
			if (!this.validateRun(run)) return;
			if (succeeded) {
				if (!(message.usage.cacheRead > 0)) {
					this.stop("refresh reported no cache hit");
					return;
				}
			} else {
				this.stop("cache refresh failed");
				return;
			}
		} catch {
			if (this.run === run) this.stop("cache refresh failed");
			return;
		}
		if (this.run === run) this.schedule(run, refreshedAt);
	}

	private refreshDeadlineMissed(run: ActiveRun): boolean {
		if (Date.now() <= run.refreshDeadlineAt) return false;
		this.stop("cache refresh deadline missed");
		return true;
	}

	private validateRun(run: ActiveRun): boolean {
		if (this.run !== run) return false;
		const reason = this.getModeStopReason(run) ?? (!run.isCurrent() ? "conversation context changed" : undefined);
		if (!reason) return true;
		this.stop(reason);
		return false;
	}

	private getModeStopReason(run: ActiveRun): string | undefined {
		const mode = this.getMode();
		if (mode === "off") return "cache warming disabled";
		if (mode === "streaming" && run.phase === "idle") return "agent run settled";
		return undefined;
	}

	private evaluate(run: ActiveRun): CacheWarmingDecision {
		const model = run.model;
		const { cached: promptTokens, input } = lastPromptTokens(this.sessionManager.getBranch());
		// With layered lifetimes only the history entry expires; the instruction prefix is still read from its own entry.
		const expiringTokens = Math.max(0, promptTokens - run.instructionTokens);
		const cacheHitCost = price(model, { cacheRead: expiringTokens });
		// A miss rewrites the expiring history at the tier the next request uses, which is the long one after an idle gap.
		const rewrite =
			run.rewriteRetention === "long"
				? { cacheWrite: expiringTokens, cacheWrite1h: expiringTokens }
				: { cacheWrite: expiringTokens };
		const cacheMissCost = price(model, model.cost.cacheWrite > 0 ? rewrite : { input: expiringTokens });
		const warmCost = price(model, {
			cacheRead: promptTokens,
			...(model.cost.cacheWrite > model.cost.input ? { cacheWrite: input } : { input }),
			output: 1,
		});
		const missCost = Math.max(0, cacheMissCost - cacheHitCost);
		const continuationProbability = run.phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
		// Pricing is known when either rate applies; a layered prompt with no expiring history still has known economics.
		const economicsAvailable =
			promptTokens > 0 &&
			(price(model, { cacheRead: promptTokens }) > 0 ||
				price(model, model.cost.cacheWrite > 0 ? { cacheWrite: promptTokens } : { input: promptTokens }) > 0);
		const expectedSavings = continuationProbability * missCost - warmCost;
		return {
			phase: run.phase,
			warmCost,
			missCost,
			continuationProbability,
			expectedSavings,
			economicsAvailable,
			action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
		};
	}
}
