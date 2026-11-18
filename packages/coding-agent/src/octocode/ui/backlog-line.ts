import { Text } from "@octocodeai/octocode-tui";
import type { FeatureSetup } from "../../core/features/index.ts";
import { BACKLOG_LINE_TYPE, lineText } from "../backlog/status-line.ts";

/** Draws the `octocode-backlog-line` entries the backlog feed writes (`backlog/peers.ts`): one dim row per state change. */
export function registerBacklogLine(api: FeatureSetup): void {
	api.renderers.entry(BACKLOG_LINE_TYPE, (entry, _options, theme) => {
		const text = lineText(entry.data);
		return text ? new Text(theme.fg("dim", text), 1, 0) : undefined;
	});
}
