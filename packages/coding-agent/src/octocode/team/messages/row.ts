import type { Endpoint, FeedEntry, TrafficState } from "@octocodeai/octocode-contracts/team";
import type { PageRow } from "../../shared/page.ts";
import { formatClock } from "../../shared/format.ts";
import { endpointMarks, endpointName } from "../endpoint.ts";

/** The row's state word colour. */
const STATE_TONE: Record<TrafficState, NonNullable<PageRow["tone"]>> = {
	queued: "muted",
	delivered: "muted",
	"awaiting reply": "warning",
	answered: "success",
	"dead-lettered": "error",
};

/** `ink(main) [worktree fix, tmux %2]`: the name, then where the agent works when that is known. */
function endpointText(endpoint: Endpoint): string {
	const marks = endpointMarks(endpoint);
	return marks.length ? `${endpointName(endpoint)} [${marks.join(", ")}]` : endpointName(endpoint);
}

/** Today's messages show the clock, older ones the date before it. */
function feedTime(at: number, now = Date.now()): string {
	const day = (value: number) => new Date(value).toDateString();
	return day(at) === day(now) ? formatClock(at) : `${new Date(at).toISOString().slice(5, 10)} ${formatClock(at)}`;
}

/** What the message is: a reply (to which), a request (it asked for an answer), a notice (its type) or plain information. */
export function feedKind(entry: FeedEntry): string {
	if (entry.internal) return entry.label ?? "notice";
	if (entry.replyTo !== undefined) return `reply to #${entry.replyTo}`;
	return entry.replyRequired ? "request" : "FYI";
}

/** The recipients: each named with its marks. */
const recipients = (entry: FeedEntry): string => entry.to.map(endpointText).join(", ") || "nobody";

/** `sender(role) [marks] → recipient(role) [marks] · #N · kind · time`; a notice has no number. */
export function feedHeader(entry: FeedEntry, now?: number): string {
	const route = `${endpointText(entry.from)} → ${recipients(entry)}`;
	const number = entry.id === undefined ? [] : [`#${entry.id}`];
	return [route, ...number, feedKind(entry), feedTime(entry.at, now)].join(" · ");
}

/** The page row of one entry: its number (or `notice`) as the name, the route, kind and time as the detail, its state at the edge. */
export function feedRow(entry: FeedEntry, keys: Readonly<Record<string, string>>, now?: number): PageRow {
	return {
		id: entry.key,
		name: entry.id === undefined ? "notice" : `#${entry.id}`,
		detail: [`${endpointText(entry.from)} → ${recipients(entry)}`, feedKind(entry), feedTime(entry.at, now)].join(
			" · ",
		),
		...(entry.state ? { badge: entry.state, tone: STATE_TONE[entry.state] } : { badge: "internal", tone: "muted" }),
		keys,
	};
}
