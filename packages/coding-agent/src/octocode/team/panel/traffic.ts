import { GLYPH, SEPARATOR, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";
import type { Endpoint, Member, Traffic } from "@octocodeai/octocode-contracts/team";
import type { Theme } from "../../../theme/theme.ts";
import { formatAgo } from "../../shared/format.ts";
import { endpointMarks, endpointName } from "../endpoint.ts";
import { safe } from "./compact.ts";
import { type PanelEntry, panelState } from "./state.ts";

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

/** A message block is never wider than this, however wide the terminal: a long line is hard to read. */
const MESSAGE_MAX = 100;
/** Body lines under a message's head line; a longer body ends in `…`. */
const BODY_LINES = 2;

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
export const continuation = (prefix: string): string => prefix.replace(/├/g, "│").replace(/└/g, " ");

/** Whether the line under an agent's row is worth keeping on a short terminal: an agent that waits for the user, or whose run ended badly or blocked. */
export const hasPriority = (entry: PanelEntry, now: number): boolean => {
	const { label } = panelState(entry, now);
	return label === "needs you" || label === "asks parent" || label === "blocked" || label === "failed";
};

const clean = (text: string) => safe(text.replace(/^[\s#>*-]+/, ""));

/**
 * The words under an agent's row for what its mark says twice: a dialog or a question waiting on someone, a finished
 * run's headline (`blocked:` and `partial:` named, since their marks are shared), or `left` without an outcome.
 */
function reasonText(entry: PanelEntry, now: number): { text: string; color: "warning" | "muted" | "dim" } | undefined {
	const { need, end } = entry;
	if (entry.doneAt !== undefined) {
		const headline = end?.headline ? clean(end.headline) : "";
		if (!end) return { text: "left", color: "dim" };
		const label = panelState(entry, now).label;
		if (label === "blocked" || label === "partial")
			return { text: headline ? `${label}: ${headline}` : label, color: label === "blocked" ? "warning" : "muted" };
		return headline ? { text: headline, color: "muted" } : undefined;
	}
	if (need?.kind === "parent")
		return { text: `asks parent${need.count > 1 ? ` ×${need.count}` : ""}`, color: "warning" };
	if (need)
		return { text: need.kind === "approval" ? "waits for your approval" : "waits for your answer", color: "warning" };
	return undefined;
}

/** The `↳` line under an agent's row (`trunk`: the tree line beside it), or undefined when its mark says enough. */
export function reasonLine(
	entry: PanelEntry,
	now: number,
	theme: Theme,
	width: number,
	trunk: string,
): string | undefined {
	const reason = reasonText(entry, now);
	if (!reason) return undefined;
	const line = ` ${theme.fg("dim", trunk)}  ${theme.fg("dim", `${GLYPH.reason} `)}${theme.fg(reason.color, reason.text)}`;
	return truncateToWidth(line, Math.max(1, width), "…");
}

/**
 * The message shown under an agent's row: the question it waits on its parent to answer, else the latest message it sent
 * (`sent`). A finished run with a headline says that instead.
 */
export function shownMessage(entry: PanelEntry, sent: Traffic | undefined): Traffic | undefined {
	if (entry.doneAt !== undefined) return entry.end?.headline ? undefined : sent;
	if (entry.need?.kind === "parent") return entry.need.message;
	return entry.need ? undefined : sent;
}

/** `inky(researcher) · worktree fix · tmux %2`, or the bare id when the recipient was not resolved. */
function endpointText(id: string, endpoint: Endpoint | undefined): string {
	const named = endpoint ? safe(endpointName(endpoint), 96) : safe(id, 64);
	const marks = endpoint ? endpointMarks(endpoint).map((mark) => safe(mark, 40)) : [];
	return [named, ...marks].join(" · ");
}

/** The recipients as the head names them: each with its role and marks when resolved; more than two collapse to the first and a count. */
function recipients(message: Traffic): string {
	const shown = message.to.length > 2 ? message.to.slice(0, 1) : message.to;
	const named = shown.map((id, index) => endpointText(id, message.toEndpoints?.[index]));
	return message.to.length > 2 ? `${named[0]} +${message.to.length - 1}` : named.join(", ");
}

/**
 * A message as a block under its sender's row, at most `MESSAGE_MAX` columns and three lines: a dim head
 * (`✉ #850 ↩#848 → other-peer · awaiting reply · 12s ago`), then the body in quotes, word-wrapped over at most two lines
 * with a one-cell hanging indent, ending in `…` when longer. `body: false` keeps the head alone.
 */
export function messageBlock(
	message: Traffic,
	now: number,
	theme: Theme,
	width: number,
	trunk: string,
	body = true,
): string[] {
	const limit = Math.max(1, Math.min(width, MESSAGE_MAX));
	const indent = ` ${theme.fg("dim", trunk)}  `;
	const indentWidth = visibleWidth(indent);
	const target = recipients(message);
	const ids = `${GLYPH.message} #${message.id}${message.replyTo ? ` ↩#${message.replyTo}` : ""} →`;
	const head = [
		`${theme.fg("dim", ids)} ${theme.fg("text", target || "nobody")}`,
		theme.fg(STATE_COLOR[message.state], message.state),
		theme.fg("dim", formatAgo(now - message.at)),
	].join(theme.fg("dim", SEPARATOR));
	const lines = [truncateToWidth(`${indent}${head}`, limit, "…")];
	// The body sits two cells further in; two cells for the quotes and one for the hanging indent.
	const room = limit - indentWidth - 5;
	const text = body ? safe(message.text, 2_000) : "";
	if (!text || room < 8) return lines;
	const wrapped = wrapTextWithAnsi(text, room);
	const shown = wrapped.slice(0, BODY_LINES);
	// A longer body: the last shown line takes the next words and is cut, so it ends in `…`.
	if (wrapped.length > BODY_LINES)
		shown[BODY_LINES - 1] = truncateToWidth(`${shown[BODY_LINES - 1]} ${wrapped[BODY_LINES]}`, room, "…");
	shown.forEach((part, index) => {
		const open = index === 0 ? '"' : " ";
		const close = index === shown.length - 1 ? '"' : "";
		lines.push(`${indent}  ${theme.fg("muted", `${open}${part}${close}`)}`);
	});
	return lines;
}
