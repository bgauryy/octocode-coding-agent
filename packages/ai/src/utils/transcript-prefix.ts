import type { Message, TranscriptContext } from "../types.ts";
import { collapseSystemMessages, type CollapseSystemOptions, type TranscriptMessages } from "./transcript.ts";

/** What the request-time transcript projection reads from a model: its API and its mid-conversation compat flag. */
export interface TranscriptModel {
	api?: string;
	compat?: object;
}

/** How an API's adapter calls {@link collapseSystemMessages}; adapters read their options here, so this is the one source. */
export function collapseOptionsFor(api: string | undefined): CollapseSystemOptions | undefined {
	return api === "mistral-conversations" ? { holdAfterToolResult: true } : undefined;
}

function leadingMessage(messages: readonly Message[], options: CollapseSystemOptions | undefined): string {
	return JSON.stringify(collapseSystemMessages({ messages } as TranscriptContext, options).messages[0]);
}

/**
 * Whether sending `messages` changes the leading prompt (the cached prefix) compared with the request before the
 * trailing system updates were recorded. A model that accepts mid-conversation system messages keeps those updates in
 * the history, so the prefix is untouched. Any other model collapses them ({@link collapseSystemMessages}), which keeps
 * the leading message byte-identical except when an update folds into it or changes the tools it carries.
 */
export function trailingUpdateRewritesPrefix(
	messages: TranscriptMessages,
	model: TranscriptModel | undefined,
): boolean {
	const compat = model?.compat;
	if (compat && "supportsMidConvoSystemMessages" in compat && compat.supportsMidConvoSystemMessages === true)
		return false;
	let end = messages.length;
	while (end > 1 && messages[end - 1].role === "system") end--;
	if (end === messages.length || messages[0]?.role !== "system") return false;
	const options = collapseOptionsFor(model?.api);
	const all = messages as readonly Message[];
	return leadingMessage(all, options) !== leadingMessage(all.slice(0, end), options);
}
