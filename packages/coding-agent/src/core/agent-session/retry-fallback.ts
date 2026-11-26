/**
 * `retry.fallbackModels`: continue a turn on another model after a failure the session retry did not clear: a usage
 * limit, a refused credential, or an outage that outlasted the retries.
 */

import { inputRoomTokens } from "../compaction/settings.ts";
import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { isCredentialError, isModelAccessError, isRateLimitedText, isUsageLimitError } from "@octocodeai/octocode-ai";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai/compat";
import { tryParseModelReference } from "../model-reference.ts";
import type { FallbackOnClass } from "../settings-defaults.ts";
import { fallbackSelectors } from "./fallback-chain.ts";
import { committedBy } from "./replay-safety.ts";
import { isVirtualModel } from "../virtual-models.ts";
import { FALLBACK_ENTRY, type FallbackFacts, fallbackNotice, fallbackRecord } from "./fallback-switch.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionModelControl } from "./model-control.ts";
import { recordRunWarning } from "./run-outcome.ts";
import { UsageLimitRecovery } from "./usage-limit-recovery.ts";

/**
 * Models that failed in this process, by `provider/id`, and when; `provider/*` after a refused credential, which fails
 * for every model of that provider. Subagents share the process's accounts.
 */
const exhausted = new Map<string, number>();

const keyOf = (provider: string, id: string) => `${provider}/${id}`;
/** Whether `key` failed less than `cooldownMs` ago (`retry.fallbackCooldownMs`: limits reset after hours, a later `/model` may pick it again). */
const recent = (key: string, cooldownMs: number) => Date.now() - (exhausted.get(key) ?? -Infinity) < cooldownMs;
const isExhausted = (provider: string, id: string, cooldownMs: number) =>
	recent(keyOf(provider, id), cooldownMs) || recent(keyOf(provider, "*"), cooldownMs);

/**
 * Why the turn moves on: `usage` a usage limit, `credential` a refused credential, `outage` retries ran out, `model` the
 * model is unavailable, `rate-limit` a rate limit outlasted the retries. Names match `retry.fallbackOn`.
 */
type FallbackReason = FallbackOnClass;

const REASON_TEXT: Record<FallbackReason, string> = {
	usage: "hit a usage limit",
	credential: "refused the credential",
	model: "was unavailable for this account or endpoint",
	outage: "kept failing after retries",
	"rate-limit": "kept being rate limited after retries",
};

export interface FallbackHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	readonly models: Pick<SessionModelControl, "setModel">;
	omitRecoveryAttempt(message: AssistantMessage): void;
	/** The session retry's own test (`SessionRetry.isRetryableError`): such a failure reaches here only after its retries. */
	isRetryable(message: AssistantMessage): boolean;
}

/** `provider/id[:thinking]`; the id may hold slashes (gateway models). */
function parseSelector(selector: string): { provider: string; id: string; thinking?: ThinkingLevel } | undefined {
	const reference = tryParseModelReference(selector);
	if (!reference?.provider) return undefined;
	return {
		provider: reference.provider,
		id: reference.id,
		...(reference.thinkingLevel ? { thinking: reference.thinkingLevel } : {}),
	};
}

export class SessionFallback {
	private readonly host: FallbackHost;
	/** What a usage limit with no fallback left turns into: a choice, a wait, or a failure naming the reset. */
	private readonly usageLimit: UsageLimitRecovery;

	constructor(host: FallbackHost) {
		this.host = host;
		this.usageLimit = new UsageLimitRecovery({
			...host,
			resume: (message) => this.resume(message),
			continueOn: (message, model) => this.continueOn(message, { model }, "usage"),
		});
	}

	/** Why a failed reply may move to another model; undefined for a failure another model would repeat. */
	private reasonOf(message: AssistantMessage): FallbackReason | undefined {
		if (message.stopReason !== "error") return undefined;
		const text = message.errorMessage ?? "";
		if (isModelAccessError(text)) return "model";
		if (isUsageLimitError(text)) return "usage";
		// A rate limit (not a usage limit, tested above) clears by waiting, which the retries did; another model would not
		// help for long, and it would stay selected. Before the credential test: one that names the key is about waiting.
		if (isRateLimitedText(text)) return this.host.isRetryable(message) ? "rate-limit" : undefined;
		if (this.host.isRetryable(message)) return "outage";
		return isCredentialError(text) ? "credential" : undefined;
	}

	/**
	 * After a failure the session retry does not take: hand a usage limit once to a virtual model's router, or select the
	 * first usable `retry.fallbackModels` entry for the rest of the session. A refused credential skips every entry of
	 * that provider; the notice names a change between plan and per-token billing, and the `FALLBACK_ENTRY` session entry
	 * records the switch for a parent that runs this session as its child. A usage limit with no entry left goes to
	 * `UsageLimitRecovery` (wait, switch or stop).
	 * @returns true if the caller should continue the agent with `run.failedResponse` set
	 */
	async prepare(message: AssistantMessage): Promise<boolean> {
		const { session } = this.host;
		const reason = this.reasonOf(message);
		if (!reason) return false;
		// A switch replays the request: not after text was shown or a tool ran, which would repeat them.
		if (committedBy(this.host.run.attempt, message)) return false;
		// The usage-limit choice is the person's: `fallbackOn` does not remove it.
		if (!session.settingsManager.getRetryFallbackOn().includes(reason))
			return reason === "usage" ? this.usageLimit.recover(message) : false;
		// The usage-limit choice is the person's, not an automatic retry: it comes with retries off too.
		if (!session.settingsManager.getRetryEnabled())
			return reason === "usage" ? this.usageLimit.recover(message) : false;
		const failedKey = keyOf(message.provider, message.model);
		const current = session.model;
		if (current && isVirtualModel(current)) {
			// The physical target was rejected. The router can choose again, and target validation prevents retrying it.
			if (reason === "model")
				return (
					session.modelRuntime.isModelAccessRejected({ provider: message.provider, id: message.model }) &&
					this.resume(message)
				);
			if (reason !== "usage") return false;
			if (isExhausted(message.provider, message.model, session.settingsManager.getRetryFallbackCooldownMs()))
				return this.usageLimit.recover(message);
			exhausted.set(failedKey, Date.now());
			return this.resume(message);
		}
		if (reason !== "model")
			exhausted.set(reason === "credential" ? keyOf(message.provider, "*") : failedKey, Date.now());
		const candidate = await this.pick(
			fallbackSelectors(session.settingsManager, message.provider, message.model),
			reason === "model" ? failedKey : undefined,
			session.settingsManager.getRetryFallbackCooldownMs(),
		);
		if (!candidate) return reason === "usage" ? this.usageLimit.recover(message) : false;
		return this.continueOn(message, candidate, reason);
	}

	/** Select `candidate` for the rest of the session after `message` failed for `reason`, say so once, and resume. */
	private async continueOn(
		message: AssistantMessage,
		candidate: { model: Model<any>; thinking?: ThinkingLevel },
		reason: FallbackReason,
	): Promise<boolean> {
		const { session, run } = this.host;
		const failedKey = keyOf(message.provider, message.model);
		await this.host.models.setModel(candidate.model, {
			persist: false,
			source: "fallback",
			level: candidate.thinking,
			reason: REASON_TEXT[reason],
		});
		const runtime = session.modelRuntime;
		const facts: FallbackFacts = {
			from: failedKey,
			to: keyOf(candidate.model.provider, candidate.model.id),
			reason: REASON_TEXT[reason],
			billing: {
				from: runtime.getProviderBilling(message.provider),
				to: runtime.getProviderBilling(candidate.model.provider),
			},
		};
		recordRunWarning(run.outcome, fallbackNotice(facts));
		const entry = session.sessionManager.getEntry(
			session.sessionManager.appendCustomEntry(FALLBACK_ENTRY, fallbackRecord(facts)),
		);
		if (entry) this.host.emit({ type: "entry_appended", entry });
		return this.resume(message);
	}

	private resume(message: AssistantMessage): boolean {
		this.host.omitRecoveryAttempt(message);
		this.host.run.failedResponse = message;
		return !this.host.run.agentRunAbortRequested;
	}

	/** The first entry that resolves, has credentials, is not exhausted or deprecated and whose window holds the context. */
	private async pick(
		selectors: readonly string[],
		rejectedModel: string | undefined,
		cooldownMs: number,
	): Promise<{ model: Model<any>; thinking?: ThinkingLevel } | undefined> {
		const { session } = this.host;
		const tokens = session.getContextUsage()?.tokens ?? undefined;
		for (const selector of selectors) {
			const parsed = parseSelector(selector.trim());
			if (
				!parsed ||
				keyOf(parsed.provider, parsed.id) === rejectedModel ||
				isExhausted(parsed.provider, parsed.id, cooldownMs)
			)
				continue;
			const runtime = session.modelRuntime;
			if (
				runtime.isProviderDisabled(parsed.provider) ||
				runtime.isModelHidden(parsed) ||
				runtime.isModelAccessRejected(parsed) ||
				// models.dev lists it as deprecated: it may stop answering, so it would not hold the session for long.
				runtime.getCatalogUpdate(parsed)?.deprecated
			)
				continue;
			const model = runtime.getPhysicalModel(parsed.provider, parsed.id);
			if (!model) continue;
			// A window too small would compact first on the exhausted model, which fails on the same limit.
			const reserve = session.settingsManager.getCompactionReserveTokens(model);
			if (
				tokens !== undefined &&
				model.contextWindow > 0 &&
				tokens > inputRoomTokens(model.contextWindow, reserve, model.inputLimits?.maxInputTokens)
			)
				continue;
			if (!(await session.modelRuntime.checkAuth(model.provider))) continue;
			return { model, thinking: parsed.thinking };
		}
		return undefined;
	}
}

/** Forget recorded failures; for tests. */
export function resetFallbackExhaustion(): void {
	exhausted.clear();
}
