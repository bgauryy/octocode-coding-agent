import { FALLBACK_ENTRY, type FallbackSwitch } from "../../core/agent-session/fallback-switch.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** A child's usage-limit entry (`USAGE_LIMIT_ENTRY`), read like its fallback switch: when its limit resets. */
export { type UsageLimitRecord, usageLimitRecord } from "../../core/agent-session/usage-limit-facts.ts";

/** The model of a child's last assistant message, and the child's switch to it. */
export interface RanModel {
	/** `provider/id`, without a thinking level. */
	model: string;
	/** The child's `retry.fallbackModels` switch, when it continued on this model. */
	fallback?: FallbackSwitch;
}

/** The switch a child's `entry_appended` event records (its `FALLBACK_ENTRY`); undefined for any other entry. */
export function fallbackSwitch(entry: unknown): FallbackSwitch | undefined {
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== FALLBACK_ENTRY || !isRecord(entry.data))
		return undefined;
	const { from, to, reason, billingChanged } = entry.data;
	return typeof from === "string" &&
		typeof to === "string" &&
		typeof reason === "string" &&
		typeof billingChanged === "boolean"
		? { from, to, reason, billingChanged }
		: undefined;
}

/** `provider/id` of an assistant message, when it names both. */
function replyModel(message: Record<string, unknown>): string | undefined {
	const { provider, model } = message;
	return typeof provider === "string" && provider && typeof model === "string" && model
		? `${provider}/${model}`
		: undefined;
}

/** What the parent keeps of an assistant reply: its model, with the switch to it. */
export function ranModel(message: Record<string, unknown>, switched: FallbackSwitch | undefined): RanModel | undefined {
	const model = replyModel(message);
	if (!model) return undefined;
	return switched?.to === model ? { model, fallback: switched } : { model };
}
