/** The model of a child's last assistant message, and what the child said about moving there. */
export interface RanModel {
	/** `provider/id`, without a thinking level. */
	model: string;
	/** Why the child's own model was replaced (`hit a usage limit`), when its notice named this model as the one it continued on. */
	cause?: string;
}

/** A child's `retry.fallbackModels` notice: `p/a hit a usage limit; continuing on p/b, billed per token (retry.fallbackModels). …`. */
const FALLBACK_NOTICE = /^\S+ (.+?); continuing on (\S+?)(?:,| \(retry\.fallbackModels\))/;

/** The model the child switched to and why, from one of its warning notices; undefined for any other notice. */
export function fallbackSwitch(text: string): { to: string; cause: string } | undefined {
	const found = FALLBACK_NOTICE.exec(text);
	return found?.[1] && found[2] ? { cause: found[1], to: found[2] } : undefined;
}

/** `provider/id` of an assistant message, when it names both. */
function replyModel(message: Record<string, unknown>): string | undefined {
	const { provider, model } = message;
	return typeof provider === "string" && provider && typeof model === "string" && model
		? `${provider}/${model}`
		: undefined;
}

/** What the parent keeps of an assistant reply: its model, with the cause of a switch to it. */
export function ranModel(
	message: Record<string, unknown>,
	switched: { to: string; cause: string } | undefined,
): RanModel | undefined {
	const model = replyModel(message);
	if (!model) return undefined;
	return switched?.to === model ? { model, cause: switched.cause } : { model };
}
