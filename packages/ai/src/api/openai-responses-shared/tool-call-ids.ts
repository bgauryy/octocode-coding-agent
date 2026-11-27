import { DEFAULT_TOOL_CALL_ID_MAX_LENGTH, fitToolCallId, sanitizeToolCallId } from "../tool-call-id.ts";
import type { AssistantMessage, Message, Model } from "../../types.ts";
import { fastHash } from "../../utils/hash.ts";

/**
 * Providers whose Responses endpoints use OpenAI's `call_…|fc_…` tool-call ids: replayed to one of them, a recorded id
 * keeps its call id and item id instead of being flattened into one.
 */
const RESPONSES_TOOL_CALL_PROVIDERS: ReadonlySet<string> = new Set(["openai", "opencode", "opencode-go"]);

const normalizePart = (part: string): string =>
	sanitizeToolCallId(part, DEFAULT_TOOL_CALL_ID_MAX_LENGTH, { trimTrailingUnderscores: true });

/**
 * The tool-call id normalizer for replaying `messages` to a Responses model (the `transformMessages` callback).
 * GitHub Copilot gives parallel calls one call_id and tells them apart by item id. Item ids are not replayed for
 * another model, so a call_id that more than one call carries is made unique with a hash of the whole id.
 */
export function responsesToolCallIdNormalizer(
	model: Pick<Model<"openai-responses" | "azure-openai-responses">, "api" | "provider">,
	messages: readonly Message[],
): (id: string, target: unknown, source: AssistantMessage) => string {
	const callIdOwners = new Map<string, Set<string>>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || !block.id.includes("|")) continue;
			const callId = block.id.split("|")[0];
			callIdOwners.set(callId, (callIdOwners.get(callId) ?? new Set()).add(block.id));
		}
	}
	const pairedIds = model.api === "azure-openai-responses" || RESPONSES_TOOL_CALL_PROVIDERS.has(model.provider);
	return (id, _target, source) => {
		// A whole foreign id keeps a hash of itself when cut to the limit, so distinct calls keep distinct ids.
		if (!pairedIds || !id.includes("|")) return fitToolCallId(id).replace(/_+$/, "");
		const [callId, itemId] = id.split("|");
		let normalizedCallId = normalizePart(callId);
		if ((callIdOwners.get(callId)?.size ?? 0) > 1) {
			const hash = fastHash(id);
			normalizedCallId = `${normalizedCallId.slice(0, DEFAULT_TOOL_CALL_ID_MAX_LENGTH - hash.length - 1)}_${hash}`;
		}
		const foreign = source.provider !== model.provider || source.api !== model.api;
		const item = foreign ? `fc_${fastHash(itemId)}` : normalizePart(itemId);
		// A Responses item id starts with "fc_"; a replayed custom-tool item keeps "ctc_".
		return `${normalizedCallId}|${!foreign && item.startsWith("ctc_") ? item : item.startsWith("fc_") ? item : `fc_${item}`}`;
	};
}
