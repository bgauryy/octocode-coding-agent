/**
 * `retry.fallbackModels`: continue a turn on another model after a failure the session retry did not clear: a usage
 * limit, a refused credential, or an outage that outlasted the retries.
 */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { isCredentialError, isModelAccessError, isUsageLimitError } from "@octocodeai/octocode-ai";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai/compat";
import { isValidThinkingLevel } from "../thinking-level.ts";
import { isVirtualModel } from "../virtual-models.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionModelControl } from "./model-control.ts";
import { recordRunWarning } from "./run-outcome.ts";

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

/** Why the turn moves on: `usage` a usage limit, `credential` a refused credential, `outage` retries ran out. */
type FallbackReason = "usage" | "credential" | "outage" | "model";

const REASON_TEXT: Record<FallbackReason, string> = {
	usage: "hit a usage limit",
	credential: "refused the credential",
	model: "was unavailable for this account or endpoint",
	outage: "kept failing after retries",
};

const billingText = (billing: string) => (billing === "plan" ? "by plan" : "per token");

export interface FallbackHost extends Pick<SessionInternals, "session" | "run"> {
	readonly models: Pick<SessionModelControl, "setModel">;
	omitRecoveryAttempt(message: AssistantMessage): void;
	/** The session retry's own test (`SessionRetry.isRetryableError`): such a failure reaches here only after its retries. */
	isRetryable(message: AssistantMessage): boolean;
}

/** `provider/id[:thinking]`; the id may hold slashes (gateway models). */
function parseSelector(selector: string): { provider: string; id: string; thinking?: ThinkingLevel } | undefined {
	const colon = selector.lastIndexOf(":");
	const level = colon > 0 ? selector.slice(colon + 1) : "";
	const base = isValidThinkingLevel(level) ? selector.slice(0, colon) : selector;
	const slash = base.indexOf("/");
	if (slash <= 0 || slash === base.length - 1) return undefined;
	return {
		provider: base.slice(0, slash),
		id: base.slice(slash + 1),
		...(isValidThinkingLevel(level) ? { thinking: level } : {}),
	};
}

export class SessionFallback {
	private readonly host: FallbackHost;

	constructor(host: FallbackHost) {
		this.host = host;
	}

	/** Why a failed reply may move to another model; undefined for a failure another model would repeat. */
	private reasonOf(message: AssistantMessage): FallbackReason | undefined {
		if (message.stopReason !== "error") return undefined;
		const text = message.errorMessage ?? "";
		if (isModelAccessError(text)) return "model";
		if (isUsageLimitError(text)) return "usage";
		// Before the credential test: a rate limit that names the key is about waiting, not the key.
		if (this.host.isRetryable(message)) return "outage";
		return isCredentialError(text) ? "credential" : undefined;
	}

	/**
	 * After a failure the session retry does not take: hand a usage limit once to a virtual model's router, or select the
	 * first usable `retry.fallbackModels` entry for the rest of the session. A refused credential skips every entry of
	 * that provider; the notice names a change between plan and per-token billing.
	 * @returns true if the caller should continue the agent with `run.failedResponse` set
	 */
	async prepare(message: AssistantMessage): Promise<boolean> {
		const { session, run } = this.host;
		const reason = this.reasonOf(message);
		if (!reason || !session.settingsManager.getRetryEnabled()) return false;
		const failedKey = keyOf(message.provider, message.model);
		const current = session.model;
		if (current && isVirtualModel(current)) {
			// The physical target was rejected. The router can choose again, and target validation prevents retrying it.
			if (reason === "model")
				return (
					session.modelRuntime.isModelAccessRejected({ provider: message.provider, id: message.model }) &&
					this.resume(message)
				);
			if (
				reason !== "usage" ||
				isExhausted(message.provider, message.model, session.settingsManager.getRetryFallbackCooldownMs())
			)
				return false;
			exhausted.set(failedKey, Date.now());
			return this.resume(message);
		}
		if (reason !== "model")
			exhausted.set(reason === "credential" ? keyOf(message.provider, "*") : failedKey, Date.now());
		const candidate = await this.pick(
			session.settingsManager.getRetryFallbackModels(),
			reason === "model" ? failedKey : undefined,
			session.settingsManager.getRetryFallbackCooldownMs(),
		);
		if (!candidate) return false;
		await this.host.models.setModel(candidate.model, {
			persist: false,
			source: "fallback",
			level: candidate.thinking,
			reason: REASON_TEXT[reason],
		});
		const runtime = session.modelRuntime;
		const from = runtime.getProviderBilling(message.provider);
		const to = runtime.getProviderBilling(candidate.model.provider);
		const billing = from === to ? "" : `, billed ${billingText(to)} instead of ${billingText(from)}`;
		const notice = `${failedKey} ${REASON_TEXT[reason]}; continuing on ${keyOf(candidate.model.provider, candidate.model.id)}${billing} (retry.fallbackModels). /model switches back.`;
		recordRunWarning(run.outcome, notice);
		return this.resume(message);
	}

	private resume(message: AssistantMessage): boolean {
		this.host.omitRecoveryAttempt(message);
		this.host.run.failedResponse = message;
		return !this.host.run.agentRunAbortRequested;
	}

	/** The first entry that resolves, has credentials, is not exhausted and whose window holds the context. */
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
				runtime.isModelAccessRejected(parsed)
			)
				continue;
			const model = runtime.getPhysicalModel(parsed.provider, parsed.id);
			if (!model) continue;
			// A window too small would compact first on the exhausted model, which fails on the same limit.
			const reserve = session.settingsManager.getCompactionReserveTokens(model);
			if (tokens !== undefined && model.contextWindow > 0 && tokens > model.contextWindow - reserve) continue;
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
