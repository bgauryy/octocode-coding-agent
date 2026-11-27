import type { Api, Model } from "../types.ts";
import type { TranscriptToolSupport } from "./transcript.ts";

/** How a transport adds tools mid-conversation: tool changes, additions only, or not without rewriting the tool list. */
export type ToolLoadingMode = TranscriptToolSupport;

interface ToolLoadingCompat {
	supportsMidConvoSystemMessages?: boolean;
	supportsMidConvoToolChanges?: boolean;
	supportsMidConvoToolAdditions?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
}

/** Derive the mode from the flags an adapter reads; adapters call this so behavior and tool exposure agree. */
export function resolveToolLoadingMode(api: Api, compat: ToolLoadingCompat | undefined): ToolLoadingMode {
	// Every mode anchors on a mid-conversation system message.
	if (compat?.supportsMidConvoSystemMessages !== true) return "none";
	switch (api) {
		case "anthropic-messages":
			return compat.supportsMidConvoToolChanges === true ? "changes" : "none";
		case "openai-responses":
		case "azure-openai-responses":
			if (compat.supportsAdditionalTools === true) return "changes";
			return compat.supportsToolSearch === true ? "additions" : "none";
		case "openai-completions":
			return compat.supportsMidConvoToolAdditions === true ? "additions" : "none";
		default:
			return "none";
	}
}

/** How the model's transport adds tools mid-conversation without rewriting the top-level tool list. */
export function getToolLoadingMode(model: Model<Api>): ToolLoadingMode {
	return resolveToolLoadingMode(model.api, model.compat as ToolLoadingCompat | undefined);
}

/** True when a mid-conversation tool load keeps the cached prefix (mode !== "none"). */
export function supportsNativeToolLoading(model: Model<Api> | undefined): boolean {
	return model !== undefined && getToolLoadingMode(model) !== "none";
}
