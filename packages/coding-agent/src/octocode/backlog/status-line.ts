import { cutText } from "@octocodeai/octocode-common/text";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import type { BacklogChange } from "../shared/backlog-change.ts";

/**
 * The session entry (`api.session.appendEntry`, never sent to the model, never a turn) that carries one backlog state
 * change as a line in the transcript and the web. The web shows it through `entryActivity`, which names this type.
 */
export const BACKLOG_LINE_TYPE = "octocode-backlog-line";

const TITLE_MAX = 60;

/** What moved the item, in a few words; undefined for a change that is not a state change (notes, steps, paths, new items). */
function movement(change: BacklogChange): string | undefined {
	switch (change.kind) {
		case "claimed":
			return "claimed";
		case "released":
			return `released${change.state ? ` (now ${change.state})` : ""}`;
		case "done":
			return "done";
		case "closed":
			return "closed";
		case "reopened":
			return `reopened${change.state ? ` (now ${change.state})` : ""}`;
		case "edited":
			return change.state && change.beforeState && change.state !== change.beforeState
				? `${change.beforeState} → ${change.state}`
				: undefined;
		default:
			return undefined;
	}
}

/** Who wrote it, when it was not this session: the web board, `/backlog`, or another agent. */
const writer = (change: BacklogChange, own: boolean): string | undefined =>
	own ? undefined : change.surface === "web" ? "web board" : change.surface === "command" ? "/backlog" : change.by;

/** `Backlog B12 done · Title · web board`, or undefined for a change that moves no state. */
export function statusLine(change: BacklogChange, own: boolean): string | undefined {
	const moved = movement(change);
	if (!moved) return undefined;
	const title = change.title
		? cutText(change.title.replace(/\s+/g, " ").trim(), TITLE_MAX, { chars: true })
		: undefined;
	return [`Backlog ${change.ref} ${moved}`, title, writer(change, own)].filter(Boolean).join(" · ");
}

/** The line of a `BACKLOG_LINE_TYPE` entry; entries from elsewhere or damaged ones yield none. */
export function lineText(data: unknown): string | undefined {
	return isRecord(data) && typeof data.text === "string" && data.text.trim() ? data.text : undefined;
}
