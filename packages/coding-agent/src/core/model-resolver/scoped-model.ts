import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { Api, Model } from "@octocodeai/octocode-ai";

/** A model a scope pattern (`--models`, `enabledModels`) resolved to. */
export interface ScopedModel {
	model: Model<Api>;
	/** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
	thinkingLevel?: ThinkingLevel;
}
