import type { AnyModel } from "../types.ts";

/** Upgrade only the historical built-in CN root; preserve explicit custom endpoints. */
export function withMiniMaxEndpoint<T extends AnyModel>(model: T): T {
	if (model.provider !== "minimax-cn" || model.baseUrl.replace(/\/$/, "") !== "https://api.minimaxi.com/anthropic")
		return model;
	return { ...model, baseUrl: "https://api.minimax.cn/anthropic" };
}
