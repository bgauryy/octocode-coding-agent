import * as os from "node:os";
import { truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { plainText } from "../styled-line.ts";

export function shortenPath(path: string): string {
	const home = os.homedir();
	if (!path) return path;
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/**
 * A session's folder for the `all` scope: the checkout it sits in (`main`, `worktree <name>`) before the path. A path too
 * long for `budget` columns gives way to the label alone, so the message keeps its room. The folder comes from the
 * session file as written, so both are drawn as plain text.
 */
export function folderColumn(folder: string, label: string | undefined, budget: number): string {
	const shown = plainText(shortenPath(folder));
	if (!label) return shown;
	const checkout = plainText(label);
	const full = `${checkout} ${shown}`;
	return visibleWidth(full) <= budget ? full : truncateToWidth(checkout, Math.max(1, budget), "…");
}

/** How long ago, for a row: `just now`, `5m ago`, `3h ago`, `2d ago`, `4w ago`, `6mo ago`, `2y ago`. */
export function formatAge(date: Date, now: number = Date.now()): string {
	const diffMs = now - date.getTime();
	const mins = Math.floor(diffMs / 60000);
	const hours = Math.floor(diffMs / 3600000);
	const days = Math.floor(diffMs / 86400000);

	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	if (hours < 24) return `${hours}h ago`;
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	if (days < 365) return `${Math.floor(days / 30)}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}

export const DAY_MS = 86_400_000;

/** Local midnight at the start of the date's day, in epoch milliseconds. */
export function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Clock time in the user's locale: `14:32` or `02:32 PM`. */
const clock = (date: Date): string => date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * When a session started, as precise as its age needs: `14:32` today, `Mon 14:32` within the week, `Oct 21 14:32`
 * this year, `Oct 21, 2025 14:32` before.
 */
export function formatStart(date: Date, now: Date = new Date()): string {
	const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
	if (days <= 0) return clock(date);
	if (days < 7) return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${clock(date)}`;
	const sameYear = date.getFullYear() === now.getFullYear();
	const day = date.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(sameYear ? {} : { year: "numeric" }),
	});
	return `${day} ${clock(date)}`;
}

/** A span as its two largest units: `45m`, `1h 33m`, `2d 3h`; empty under a minute. */
export function formatDuration(ms: number): string {
	const mins = Math.floor(ms / 60_000);
	if (mins < 1) return "";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** A real session start: a valid date after the epoch (listings use the epoch or an invalid date when it is unknown). */
export const knownStart = (date: Date): boolean => Number.isFinite(date.getTime()) && date.getTime() > 0;

/**
 * The time of a session for a row: when it started and how long it ran until its last activity, `14:32 (1h 33m)`.
 * Empty when the start is unknown.
 */
export function formatSessionTime(created: Date, modified: Date, now: Date = new Date()): string {
	if (!knownStart(created)) return "";
	const span = formatDuration(modified.getTime() - created.getTime());
	return span ? `${formatStart(created, now)} (${span})` : formatStart(created, now);
}

export { deleteSessionFile } from "../../../../core/session-manager/delete-file.ts";
