import { GLYPH, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import type { Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { Theme } from "../../theme/theme.ts";
import { formatAgo } from "../shared/format.ts";
import { safe } from "./panel-compact.ts";

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

/**
 * Messages between this session's subagents. Messages to or from this session are left out: they are already in its
 * transcript.
 */
export function ownTraffic(traffic: Traffic[], members: Member[], selfId: string | undefined): Traffic[] {
	if (!selfId) return [];
	const mine = new Set(members.map((member) => member.id));
	return traffic.filter(
		(message) =>
			message.from !== selfId &&
			!message.to.includes(selfId) &&
			(mine.has(message.from) || message.to.some((to) => mine.has(to))),
	);
}
