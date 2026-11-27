import type { Endpoint, FeedEntry, TranscriptRef } from "@octocodeai/octocode-contracts/team";
import type { ProfileTranscriptEntry } from "@octocodeai/octocode-contracts/profiler";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";
import { endpointLabel } from "../endpoint.ts";
import { feedKind } from "./row.ts";

/** Reads the transcript entry a feed entry links to (`FeedEntry.transcript`); undefined when that transcript is not on disk. */
export type TranscriptReader = (ref: TranscriptRef) => ProfileTranscriptEntry | undefined;

/** Characters of one body, thinking or output shown on the page; the rest stays in the transcript. */
const SHOWN_CHARS = 20_000;

export interface Fact {
	label: string;
	value: string;
}

const shown = (value: string): string => {
	const clean = sanitizeTerminalText(value).trim();
	return clean.length > SHOWN_CHARS
		? `${clean.slice(0, SHOWN_CHARS)}\n… (${clean.length - SHOWN_CHARS} more characters)`
		: clean;
};

const recipient = (entry: FeedEntry, end: Endpoint): string => {
	const state = entry.deliveries?.find((delivery) => delivery.recipient === end.id)?.state ?? entry.state;
	return [endpointLabel(end), state].filter(Boolean).join(" · ");
};

/** What the sender was thinking and wrote when it sent: the linked transcript entry's thinking and text. */
function transcriptFacts(entry: FeedEntry, read: TranscriptReader): Fact[] {
	if (entry.internal)
		return [{ label: "Notice", value: `${entry.label ?? "notice"} — held by the receiver's own session` }];
	if (!entry.transcript) return [{ label: "Transcript", value: "none recorded for the sender" }];
	const found = read(entry.transcript);
	if (!found) return [{ label: "Transcript", value: `${entry.transcript.agentId}'s transcript is not on disk` }];
	return [
		{ label: "Thinking", value: found.thinking ? shown(found.thinking) : "none in the sender's reply" },
		{ label: "Output", value: found.text ? shown(found.text) : "none in the sender's reply" },
		...(found.tools?.length ? [{ label: "Tools", value: found.tools.join(", ") }] : []),
	];
}

/** The facts of one entry's page: the route with marks, delivery per recipient, the whole body, and the sender's thinking and output. */
export function entryFacts(entry: FeedEntry, read: TranscriptReader): Fact[] {
	return [
		{ label: "From", value: endpointLabel(entry.from) },
		{ label: "To", value: entry.to.map((end) => recipient(entry, end)).join("\n") || "nobody" },
		{ label: "Sent", value: new Date(entry.at).toLocaleString() },
		{ label: "Kind", value: feedKind(entry) },
		{ label: "Body", value: shown(entry.text) || "(empty)" },
		...transcriptFacts(entry, read),
	];
}
