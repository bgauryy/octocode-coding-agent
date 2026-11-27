/** /model with `provider/id` where the provider is known but does not list the id: confirm before selecting it. */

import type { Api, Model } from "@octocodeai/octocode-ai";
import { didYouMean, findUnlistedModel } from "../../../core/model-resolver/suggestions.ts";
import type { InteractiveModeHost } from "./host.ts";

/**
 * The custom model after the user confirms, "declined" when they refuse, undefined when the text is not an unlisted id
 * under a known provider (nothing to ask).
 */
export async function confirmUnlistedModel(
	ctx: Pick<InteractiveModeHost, "session" | "showConfirmDialog">,
	text: string,
): Promise<Model<Api> | "declined" | undefined> {
	const unlisted = findUnlistedModel(text, [...ctx.session.modelRuntime.getModels()]);
	if (!unlisted) return undefined;
	const ok = await ctx.showConfirmDialog(
		"Unknown model id",
		`${unlisted.provider} does not list "${unlisted.modelId}", so requests may fail.${didYouMean(unlisted.suggestions)} Select it anyway?`,
	);
	return ok ? unlisted.model : "declined";
}
