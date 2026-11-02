import { Box, Text } from "@octocodeai/octocode-tui";
import type { ExtensionAPI } from "../../../core/features/index.ts";
import { fencedBody } from "../../shared/fence.ts";
import { formatClock } from "../../shared/format.ts";
import { EXTERNAL_MESSAGE_TYPE } from "../../shared/messages.ts";
import { resultBlock } from "../../shared/render.ts";
import { contentText } from "../../shared/util.ts";
import { clip } from "../../shared/render/text.ts";

/** `✉ from <client>`, then the client's text: untrusted, so resultBlock sanitizes and previews it instead of Markdown. */
export function registerExternalMessageRenderer(api: ExtensionAPI): void {
	api.registerMessageRenderer(EXTERNAL_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as { from?: unknown; at?: unknown } | undefined;
		const from = clip(typeof details?.from === "string" ? details.from : "API client", 60);
		const text = contentText(message.content);
		// The content is the fenced message the model reads; the header above says who sent it, so draw only the body.
		const body = fencedBody(text);
		const box = new Box(outputPad ?? 1, 0);
		box.addChild(
			new Text(
				`${theme.fg("accent", "✉")} ${theme.fg("toolTitle", theme.bold(`from ${from}`))} ${theme.fg("dim", `· Octocode API · ${formatClock(typeof details?.at === "number" ? details.at : Date.now())}`)}`,
				0,
				0,
			),
		);
		box.addChild(resultBlock(theme, { expanded }, { summary: "", body, error: false }));
		return box;
	});
}
