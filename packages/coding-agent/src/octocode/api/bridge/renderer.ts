import { Box, Text } from "@octocodeai/octocode-tui";
import type { FeatureSetup } from "../../../core/features/index.ts";
import { fencedBody } from "../../shared/fence.ts";
import { formatClock } from "../../shared/format.ts";
import { EXTERNAL_MESSAGE_TYPE } from "../../shared/messages.ts";
import { resultBlock } from "../../render/tool.ts";
import { TOOL_PREVIEW_LINES } from "../../../theme/theme-tui-helpers.ts";
import { contentText } from "../../shared/util.ts";
import { clip } from "../../shared/text.ts";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import type { ExternalFacts } from "./caller.ts";

/** The caller as a person reads it: what it claims, never presented as checked. */
function externalCallerLine(facts: Partial<ExternalFacts> | undefined): string {
	return [facts?.name, facts?.instanceId, facts?.pid === undefined ? undefined : `pid ${facts.pid}`, facts?.cwd]
		.filter(Boolean)
		.join(" · ");
}

/** `✉ external · says it is <client>`, the caller it claims, then its text: untrusted, so resultBlock sanitizes and previews it instead of Markdown. */
export function registerExternalMessageRenderer(api: FeatureSetup): void {
	api.renderers.message(EXTERNAL_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as { from?: unknown; at?: unknown; external?: Partial<ExternalFacts> } | undefined;
		const from = clip(typeof details?.from === "string" ? details.from : "API client", 60);
		const text = contentText(message.content);
		// The content is the fenced message the model reads; the header above says who sent it, so draw only the body.
		const body = fencedBody(text);
		const caller = clip(sanitizeTerminalText(externalCallerLine(details?.external)), 160);
		const box = new Box(outputPad ?? 1, 0);
		box.addChild(
			new Text(
				`${theme.fg("warning", "✉ external")} ${theme.fg("toolTitle", theme.bold(`says it is ${from}`))} ${theme.fg("dim", `· another process, not you · ${formatClock(typeof details?.at === "number" ? details.at : Date.now())}`)}`,
				0,
				0,
			),
		);
		if (caller) box.addChild(new Text(theme.fg("dim", caller), 0, 0));
		// A message, not a tool result: its first lines stay in view.
		box.addChild(resultBlock(theme, { expanded }, { summary: "", body, error: false, max: TOOL_PREVIEW_LINES }));
		return box;
	});
}
