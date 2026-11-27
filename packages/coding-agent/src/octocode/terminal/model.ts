import type { NextCommandRequest } from "../../../../terminal/src/index.ts";
import type { SetupPick, FeatureContext } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { type CompleteSmall, callSmallModel } from "../subagents/small-call.ts";

const NONE = "NONE";
/** A command fits in far fewer; the cap only stops a model that ignores the format. */
const MAX_TOKENS = 128;

/** The prompt for one suggestion (`native/prompts/workflows/shell-suggest.md`). */
export function suggestionPrompt(request: NextCommandRequest): string {
	const strip = (text: string) => text.replaceAll("</", "<\\/");
	return renderPrompt("workflows/shell-suggest.md", {
		none: NONE,
		shell: request.shell,
		platform: request.platform,
		cwd: request.cwd,
		recent:
			request.recent
				.map((each) => strip(`${each.command}${typeof each.exitCode === "number" ? `  # exit ${each.exitCode}` : ""}`))
				.join("\n") || "(none)",
		reply: request.reply.map(strip).join("\n") || "(none)",
		typed: strip(request.prefix),
	});
}

/**
 * One small-tier call for the rest of a `!` command: the cheapest capable model among the providers the user is signed
 * in to (`callSmallModel`), never the session's own model. Its usage is recorded in the session. Undefined when no such
 * model is available or the call fails.
 */
export async function askSmallModel(
	api: SetupPick<"usage", "record">,
	ctx: FeatureContext,
	request: NextCommandRequest,
	signal: AbortSignal,
	complete?: CompleteSmall,
): Promise<string | undefined> {
	const reply = await callSmallModel(ctx, {
		text: suggestionPrompt(request),
		signal,
		maxTokens: MAX_TOKENS,
		...(complete ? { complete } : {}),
	});
	if ("error" in reply) return undefined;
	try {
		api.usage.record("shell_suggestion", reply.provider, reply.modelId, reply.usage);
	} catch {
		// A session that cannot record usage still gets the suggestion.
	}
	return reply.text;
}
