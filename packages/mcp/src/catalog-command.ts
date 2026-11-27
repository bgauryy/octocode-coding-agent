/** `/mcp resources`, `/mcp prompts` and `/mcp prompt`: a server's resources and prompts for the user. */

import { promptListing, promptText, resourceListing } from "./catalog-requests.ts";
import type { McpCommandContext } from "./host/types.ts";
import { say } from "./notice.ts";
import type { McpFeatureState } from "./state.ts";

export const CATALOG_ACTIONS = ["resources", "prompts", "prompt"] as const;
export const CATALOG_USAGE = "/mcp resources <server>, /mcp prompts <server>, /mcp prompt <server> <name> [args]";

/** Words as a shell splits them: whitespace separates, and single or double quotes keep spaces in one word, also inside `key="a b"`; `""` is an empty word. */
export function commandWords(text: string): string[] {
	const words: string[] = [];
	for (const [word] of text.matchAll(/(?:[^\s"']+|"[^"]*"|'[^']*'|["'])+/g))
		words.push(
			word.replace(/"([^"]*)"|'([^']*)'/g, (_all, double?: string, single?: string) => double ?? single ?? ""),
		);
	return words;
}

/**
 * Runs a catalog subcommand from the text after `/mcp`. A prompt's messages are sent as the user's next message (shown
 * instead when the host cannot send one); listings are shown.
 */
export async function catalogCommand(state: McpFeatureState, args: string, ctx: McpCommandContext): Promise<void> {
	const [action, server, prompt, ...rest] = commandWords(args);
	if (!server || (action === "prompt" ? !prompt : prompt !== undefined))
		return say(ctx, `Usage: ${CATALOG_USAGE}`, "warning");
	state.startupGate.open();
	await state.pending;
	try {
		if (action === "resources") return say(ctx, await resourceListing(state, server), "info");
		if (action === "prompts") return say(ctx, await promptListing(state, server), "info");
		const text = await promptText(state, server, prompt, rest);
		if (state.api.session.sendUserMessage) state.api.session.sendUserMessage(text);
		else say(ctx, text, "info");
	} catch (error) {
		say(ctx, error instanceof Error ? error.message : String(error), "error");
	}
}
