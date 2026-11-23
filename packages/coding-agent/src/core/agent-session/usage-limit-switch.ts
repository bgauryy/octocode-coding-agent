/**
 * The model a turn that ended on a usage limit can switch to when `retry.fallbackModels` offered none: a connected model
 * of another provider (the limit is the account's, so every model of the failed provider shares it).
 */

import type { Api, Model } from "@octocodeai/octocode-ai";
import { inputRoomTokens } from "../compaction/settings.ts";
import { defaultModelPerProvider } from "../model-resolver/default-models.ts";
import { isVirtualModel } from "../virtual-models.ts";
import type { SessionPublic } from "./host.ts";

type Runtime = Pick<SessionPublic["modelRuntime"], "getAvailable" | "getProviderBilling" | "isModelDeprecated">;

export interface SwitchCandidateHost {
	readonly modelRuntime: Runtime;
	readonly settingsManager: Pick<SessionPublic["settingsManager"], "getCompactionReserveTokens">;
	/** The context the switched model must hold, in tokens; undefined when unknown. */
	readonly contextTokens: number | undefined;
}

/** Whether two ids name one model, one behind a gateway's or a cross-region prefix: `claude-x`, `anthropic/claude-x`, `us.anthropic.claude-x`. */
function sameModel(a: string, b: string): boolean {
	const [x, y] = [a.toLowerCase(), b.toLowerCase()];
	const under = (long: string, short: string) => long.endsWith(`/${short}`) || long.endsWith(`.${short}`);
	return x === y || under(x, y) || under(y, x);
}

/**
 * The best connected model of another provider than `failed`'s, by the routing preference: plan billing before
 * per-token billing (a plan costs no money), then the failed model itself served by another provider, then that
 * provider's default model. Each candidate is listed (credentials present, provider enabled, plan not paused, not
 * hidden or refused: `getAvailable`), not deprecated in the catalog, and holds the current context. Undefined when none.
 */
export async function nextConnectedModel(
	host: SwitchCandidateHost,
	failed: { provider: string; id: string },
): Promise<Model<Api> | undefined> {
	const runtime = host.modelRuntime;
	const fits = (model: Model<Api>): boolean => {
		if (host.contextTokens === undefined || model.contextWindow <= 0) return true;
		const reserve = host.settingsManager.getCompactionReserveTokens(model);
		return host.contextTokens <= inputRoomTokens(model.contextWindow, reserve, model.inputLimits?.maxInputTokens);
	};
	/** Lower ranks first: 0 the same model elsewhere, 1 the provider's default model, else not offered. */
	const rankOf = (model: Model<Api>): number | undefined => {
		if (sameModel(model.id, failed.id)) return 0;
		const preferred = (defaultModelPerProvider as Record<string, string | undefined>)[model.provider];
		return preferred !== undefined && model.id === preferred ? 1 : undefined;
	};
	let best: { model: Model<Api>; score: number } | undefined;
	for (const model of await runtime.getAvailable()) {
		if (model.provider === failed.provider || isVirtualModel(model)) continue;
		const rank = rankOf(model);
		if (rank === undefined || runtime.isModelDeprecated(model) || !fits(model)) continue;
		const score = (runtime.getProviderBilling(model.provider) === "plan" ? 0 : 2) + rank;
		if (!best || score < best.score) best = { model, score };
	}
	return best?.model;
}
