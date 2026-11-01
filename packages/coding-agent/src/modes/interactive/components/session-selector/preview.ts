import { truncateToWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";
import { sanitizeTerminalText } from "../../../../../../common/src/sanitize.ts";
import type { SessionInfo } from "../../../../core/session-manager.ts";
import { sessionTitle } from "../../../../core/session-manager/title.ts";
import { theme } from "../../../../theme/theme.ts";
import type { SessionExtras } from "./types.ts";
import { formatAge, formatDuration, knownStart, shortenPath } from "./utils.ts";

/** Most lines the first prompt takes in the preview. */
const PROMPT_LINES = 6;

function extrasText(extras: SessionExtras | undefined): string {
	if (!extras) return "";
	const parts = [
		extras.live ? "running" : undefined,
		extras.branch,
		extras.checkout,
		extras.cost,
		extras.files ? `${extras.files} file${extras.files === 1 ? "" : "s"}` : undefined,
		...(extras.items ?? []),
		extras.agent,
		extras.children ? `${extras.children} child agent${extras.children === 1 ? "" : "s"}` : undefined,
	];
	return parts.filter(Boolean).join(" · ");
}

/** The detail view of one session: title, first prompt, folder and extras, every line within `width`. */
export function renderPreview(session: SessionInfo, extras: SessionExtras | undefined, width: number): string[] {
	const inner = Math.max(1, width - 2);
	const fit = (text: string) => ` ${truncateToWidth(text, inner, "…")}`;
	const lines = [fit(theme.bold(sessionTitle(session, 200) || "(no prompt yet)")), ""];

	const prompt = sanitizeTerminalText(session.firstMessage).trim();
	if (prompt) {
		lines.push(fit(theme.fg("muted", "First prompt")));
		const wrapped = wrapTextWithAnsi(prompt, inner).slice(0, PROMPT_LINES);
		for (const line of wrapped) lines.push(fit(line));
		lines.push("");
	}

	lines.push(fit(`${theme.fg("muted", "Folder   ")} ${sanitizeTerminalText(shortenPath(session.cwd)) || "(unknown)"}`));
	if (knownStart(session.created)) {
		const span = formatDuration(session.modified.getTime() - session.created.getTime());
		const at = session.created.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
		lines.push(fit(`${theme.fg("muted", "Started  ")} ${at}${span ? ` · ran ${span}` : ""}`));
	}
	lines.push(fit(`${theme.fg("muted", "Active   ")} ${formatAge(session.modified)} · ${session.messageCount} msgs`));
	const more = extrasText(extras);
	if (more) lines.push(fit(`${theme.fg("muted", "Details  ")} ${sanitizeTerminalText(more)}`));
	lines.push(fit(`${theme.fg("muted", "Id       ")} ${sanitizeTerminalText(session.id)}`));
	return lines;
}
