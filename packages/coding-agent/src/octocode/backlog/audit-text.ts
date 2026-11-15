import type { BacklogAudit } from "@octocodeai/octocode-contracts/snapshot";
import { clipText } from "../../../../common/src/clip.ts";
import { visibleControls } from "../../../../common/src/sanitize.ts";

/** How many of the newest audit rows `get` shows; the board's Audit view and `store.audit` page through the rest. */
export const AUDIT_SHOWN = 8;

const brief = (value: unknown): string => {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return clipText(text, 60);
};

/** What an audit row changed: the fields of a `backlog` update that differ (before → after), else the entity and action. */
function changes(event: BacklogAudit): string {
	const before = event.before as Record<string, unknown> | null;
	const after = event.after as Record<string, unknown> | null;
	if (event.entity !== "backlog" || event.action !== "update" || !before || !after)
		return `${event.action} ${event.entity}`;
	const ignored = new Set(["updated_at", "version", "started_at", "done_at"]);
	const fields = Object.keys(after).filter((key) => !ignored.has(key) && before[key] !== after[key]);
	return fields.map((key) => `${key} ${brief(before[key] ?? "none")} → ${brief(after[key] ?? "none")}`).join("; ");
}

/** The audit rows of an item (the store returns the newest ones, oldest first): when, who (actor kind, session or name, surface) and what changed. */
export function auditText(events: readonly BacklogAudit[]): string {
	if (!events.length) return "";
	const rows = events.map((event) => {
		const who = `${visibleControls(event.actor.id)} (${event.actor.kind ?? "system"}${event.actor.surface ? ` via ${event.actor.surface}` : ""})`;
		return `- ${new Date(event.at).toISOString()} ${who}: ${visibleControls(changes(event))}`;
	});
	return `\nAudit (latest ${rows.length}):\n${rows.join("\n")}`;
}
