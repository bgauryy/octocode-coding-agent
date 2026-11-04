import { GLYPH, SEPARATOR, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { Theme } from "../../theme/theme.ts";
import { formatAgo } from "../shared/format.ts";
import { fitName, safe } from "./panel-compact.ts";
import { type PanelEntry, panelState } from "./panel-state.ts";

/** The colour of each delivery state's word. */
const STATE_COLOR = {
	queued: "dim",
	delivered: "muted",
	"awaiting reply": "warning",
	answered: "success",
	"dead-lettered": "error",
} as const;

/** `✉ #12 main-a → researcher-b · awaiting reply  "check the tests"` */
export function trafficRow(message: Traffic, now: number, theme: Theme, width: number): string {
	const to =
		safe(message.to.length > 2 ? `${message.to[0]} +${message.to.length - 1}` : message.to.join(", "), 80) || "nobody";
	const head = `${theme.fg("accent", GLYPH.message)} ${theme.fg("dim", `#${message.id}${message.replyTo ? `↩#${message.replyTo}` : ""}`)} ${theme.fg("text", safe(message.from, 64))} ${theme.fg("dim", "→")} ${theme.fg("text", to)}`;
	const state = theme.fg(STATE_COLOR[message.state], message.state);
	const body = theme.fg("muted", `"${safe(message.text)}"`);
	if (visibleWidth(head) + visibleWidth(message.state) + 5 > width) {
		return truncateToWidth(
			` ${theme.fg("accent", GLYPH.message)} ${theme.fg("dim", `#${message.id}`)} ${state} · ${theme.fg("text", safe(message.from, 64))} → ${theme.fg("text", to)} ${body}`,
			Math.max(1, width),
			"…",
		);
	}
	return truncateToWidth(
		` ${head} ${theme.fg("dim", `${formatAgo(now - message.at)} ·`)} ${state}  ${body}`,
		Math.max(1, width),
		"…",
	);
}

/** The body is shown only with at least this many cells; a shorter stub says nothing. */
const BODY_MIN = 8;

/**
 * The latest message each of `members` sent, for the line under its row. A message to this session is left out unless it
 * still waits for an answer: the rest is already in the transcript. Messages that no agent of this session sent (other
 * sessions' traffic) are never shown.
 */
export function sentMessages(traffic: Traffic[], members: Member[], selfId: string | undefined): Map<string, Traffic> {
	const latest = new Map<string, Traffic>();
	if (!selfId) return latest;
	const mine = new Set(members.map((member) => member.id));
	for (const message of traffic) {
		if (!mine.has(message.from)) continue;
		if (message.to.includes(selfId) && message.state !== "awaiting reply") continue;
		const known = latest.get(message.from);
		if (!known || message.at > known.at || (message.at === known.at && message.id > known.id))
			latest.set(message.from, message);
	}
	return latest;
}

/** Continuation of a row's tree connector for a line below it: `├ ` carries on as `│ `, `└ ` ends. */
const continuation = (prefix: string): string => prefix.replace(/├/g, "│").replace(/└/g, " ");

/** Whether the line under an agent's row is worth keeping on a short terminal: an agent that waits for the user, or whose run ended badly or blocked. */
export const hasPriority = (entry: PanelEntry, now: number): boolean => {
	const { label } = panelState(entry, now);
	return label === "needs you" || label === "blocked" || label === "failed";
};

const clean = (text: string) => safe(text.replace(/^[\s#>*-]+/, ""));

/** What the line says, as parts in the order they give way when the row is narrow: the first part always stays. */
interface Parts {
	lead: string;
	/** Optional parts, last to leave first. */
	extras: string[];
	body: string;
}

function messageParts(entry: PanelEntry, message: Traffic | undefined, now: number, theme: Theme): Parts | undefined {
	const { need, end } = entry;
	if (entry.doneAt !== undefined) {
		const headline = end?.headline ? clean(end.headline) : "";
		if (headline) return { lead: "", extras: [], body: headline };
		return message ? messageParts({ ...entry, doneAt: undefined }, message, now, theme) : undefined;
	}
	if (need?.kind === "ask" && need.message) {
		const ask = need.message;
		const count = need.count > 1 ? ` ×${need.count}` : "";
		return {
			lead: `${theme.fg("dim", `#${ask.id} →`)} ${theme.fg("text", "you")}${SEPARATOR}${theme.fg("warning", `awaiting reply${count}`)}`,
			extras: [
				theme.fg("dim", formatAgo(now - ask.at)),
				theme.fg("warning", `/agents tell ${safe(entry.member.id, 64)} #${ask.id} <reply>`),
			],
			body: safe(ask.text),
		};
	}
	if (need) return { lead: theme.fg("warning", "waiting for your approval"), extras: [], body: "" };
	if (!message) return undefined;
	const target =
		message.to.length > 2
			? `${safe(message.to[0] ?? "", 64)} +${message.to.length - 1}`
			: message.to.map((id) => safe(id, 64)).join(", ");
	return {
		lead: `${theme.fg("dim", `#${message.id}${message.replyTo ? `↩#${message.replyTo}` : ""} →`)} ${theme.fg("text", target || "nobody")}${SEPARATOR}${theme.fg(STATE_COLOR[message.state], message.state)}`,
		extras: [theme.fg("dim", formatAgo(now - message.at))],
		body: safe(message.text),
	};
}

/**
 * The muted line under an agent's row: what it last said (`↳ → calm-heron · awaiting reply · 12s · "review the diff…"`),
 * the question it waits on you to answer with its ready `/agents tell` command, or a finished run's headline. When the
 * row is narrow the body shrinks first, then the extras (age, the command) leave from the last; the lead stays.
 */
export function noteLine(
	entry: PanelEntry,
	message: Traffic | undefined,
	now: number,
	theme: Theme,
	width: number,
	under: string,
): string | undefined {
	const parts = messageParts(entry, message, now, theme);
	if (!parts) return undefined;
	const start = ` ${theme.fg("dim", continuation(under))}  ${theme.fg("dim", GLYPH.reason)} `;
	const join = (items: string[]) => items.filter(Boolean).join(theme.fg("dim", SEPARATOR));
	const extras = [...parts.extras];
	const fixed = () => start + join([parts.lead, ...extras]);
	// The ready command outranks the age: drop the age first, then the command.
	while (extras.length > 0 && visibleWidth(fixed()) > width) extras.shift();
	const room = width - visibleWidth(fixed()) - SEPARATOR.length - 2;
	const body = parts.body && room >= BODY_MIN ? `"${fitName(parts.body, room)}"` : "";
	return truncateToWidth(
		`${start}${join([parts.lead, ...extras, body && theme.fg("muted", body)])}`,
		Math.max(1, width),
		"…",
	);
}
