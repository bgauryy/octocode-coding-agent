/** `retry.fallbackModels`: continue a turn on another model after a usage-limit failure. */

import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { isUsageLimitError } from "@octocodeai/octocode-ai";
import type { AssistantMessage, Model } from "@octocodeai/octocode-ai/compat";
import { isValidThinkingLevel } from "../thinking-level.ts";
import { isVirtualModel } from "../virtual-models.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionModelControl } from "./model-control.ts";
import { recordRunWarning } from "./run-outcome.ts";

/** How long a model that hit a usage limit is skipped: limits reset after hours, a later `/model` may pick it again. */
const EXHAUSTED_MS = 15 * 60_000;
/** Models that failed on a usage limit in this process, by `provider/id`, and when. Subagents share the process's accounts. */
const exhausted = new Map<string, number>();

const keyOf = (provider: string, id: string) => `${provider}/${id}`;
const isExhausted = (key: string) => Date.now() - (exhausted.get(key) ?? -Infinity) < EXHAUSTED_MS;

export interface FallbackHost extends Pick<SessionInternals, "session" | "run"> {
	readonly models: Pick<SessionModelControl, "setModel">;
	omitRecoveryAttempt(message: AssistantMessage): void;
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

	/**
	 * After a failure the session retry does not take: when it names a usage limit, hand it once to a virtual model's
	 * router, or select the first usable `retry.fallbackModels` entry for the rest of the session.
	 * @returns true if the caller should continue the agent with `run.failedResponse` set
	 */
	async prepare(message: AssistantMessage): Promise<boolean> {
		const { session, run } = this.host;
		if (message.stopReason !== "error" || !isUsageLimitError(message.errorMessage ?? "")) return false;
		if (!session.settingsManager.getRetryEnabled()) return false;
		const failedKey = keyOf(message.provider, message.model);
		const current = session.model;
		if (current && isVirtualModel(current)) {
			if (isExhausted(failedKey)) return false;
			exhausted.set(failedKey, Date.now());
			return this.resume(message);
		}
		exhausted.set(failedKey, Date.now());
		const candidate = await this.pick(session.settingsManager.getRetryFallbackModels());
		if (!candidate) return false;
		await this.host.models.setModel(candidate.model, { persist: false, source: "fallback", level: candidate.thinking });
		const notice = `${failedKey} hit a usage limit; continuing on ${keyOf(candidate.model.provider, candidate.model.id)} (retry.fallbackModels). /model switches back.`;
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
	): Promise<{ model: Model<any>; thinking?: ThinkingLevel } | undefined> {
		const { session } = this.host;
		const tokens = session.getContextUsage()?.tokens ?? undefined;
		for (const selector of selectors) {
			const parsed = parseSelector(selector.trim());
			if (!parsed || isExhausted(keyOf(parsed.provider, parsed.id))) continue;
			const model = session.modelRuntime.getPhysicalModel(parsed.provider, parsed.id);
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

/** Forget recorded usage limits; for tests. */
export function resetFallbackExhaustion(): void {
	exhausted.clear();
}
