import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/** The session entry (never sent to the model) that shows one batch of wake events as a single row. */
export const WAKE_TYPE = "octocode-wake";

/** One event as the row lists it. */
export interface WakeLine {
	kind: string;
	label: string;
	/** The origin named by the event. Older session entries hold only a label. */
	from?: string;
	data?: Record<string, unknown>;
}

/** The events of an `octocode-wake` entry; entries from elsewhere or damaged ones yield none. */
export function readWakeLines(data: unknown): WakeLine[] {
	if (!isRecord(data) || !Array.isArray(data.events)) return [];
	const field = (value: string) => sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
	return data.events.flatMap((each): WakeLine[] =>
		isRecord(each) && typeof each.kind === "string" && typeof each.label === "string"
			? [
					{
						kind: field(each.kind),
						label: field(each.label),
						...(isRecord(each.data) ? { data: each.data } : {}),
						...(typeof each.from === "string" ? { from: field(each.from) } : {}),
					},
				]
			: [],
	);
}
