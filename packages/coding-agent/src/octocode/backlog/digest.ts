import { renderInstruction } from "../../core/prompt-template.ts";
import type { ExtensionAPI } from "../../core/features/index.ts";
import { clip } from "../shared/render/text.ts";
import { type BacklogOptions, openBacklog } from "./context.ts";
import { priorityName } from "./item.ts";
import type { BacklogStore } from "./store.ts";

/** The customType of the digest message. */
export const BACKLOG_DIGEST_TYPE = "backlog-digest";

const MAX_ONGOING = 3;
const MAX_TOP = 3;
const TITLE_CHARS = 48;
/** Open items read to find the most urgent; the board lists urgent ones first within a state, so this is enough. */
const SCAN = 30;

/**
 * A short orientation for a fresh session: the open work this session holds or another session left behind (holder
 * ended), how many items are to do and proposed, and the most urgent open titles. Undefined when the board has
 * nothing open.
 */
function backlogDigest(store: BacklogStore, session: string): string | undefined {
	const { todo, backlog: proposed, ongoing: running } = store.counts().items;
	if (todo + proposed + running === 0) return undefined;
	const items = store.list({ states: ["ongoing"], limit: SCAN }).items;
	const stale = store.marks(items, session);
	const mine = items.filter((item) => item.assignee === session);
	const abandoned = items.filter((item) => stale.get(item.ref)?.stale);
	const named = [...mine, ...abandoned];
	const shown = named
		.slice(0, MAX_ONGOING)
		.map(
			(item) =>
				`${item.ref} "${clip(item.title, TITLE_CHARS)}" (${item.assignee === session ? "yours" : "stale: holder ended"})`,
		);
	if (named.length > MAX_ONGOING) shown.push(`${named.length - MAX_ONGOING} more`);
	const elsewhere = items.length - named.length;
	if (elsewhere > 0) shown.push(`${elsewhere} held by live sessions`);
	const top = store
		.list({ states: ["todo", "backlog"], maxPriority: 1, limit: SCAN })
		.items.toSorted((a, b) => a.priority - b.priority)
		.slice(0, MAX_TOP)
		.map((item) => `${item.ref} ${priorityName(item.priority)} "${clip(item.title, TITLE_CHARS)}"`);
	return renderInstruction("notices/backlog-digest.md", {
		todo,
		proposed,
		ongoing: shown.join("; "),
		top: top.join("; "),
	});
}

/** Hands the digest to the first prompt of a fresh main session (a new start or `/new`); a resume has its own brief. */
export function registerBacklogDigest(api: ExtensionAPI, options: BacklogOptions): void {
	let pending: string | undefined;
	api.on("session_start", (event, ctx) => {
		pending = undefined;
		if (event.reason !== "startup" && event.reason !== "new") return;
		try {
			const backlog = openBacklog(ctx, options);
			pending = backlogDigest(backlog.store, backlog.session);
		} catch {
			// An unreadable database gives no digest; the backlog tool reports the cause when asked.
		}
	});
	api.on("before_agent_start", () => {
		const content = pending;
		pending = undefined;
		// A session run without the tool (`defaultTools: ["-backlog"]`, `/configuration disable tool:backlog`, `octocode --disable tool:backlog`) has no use for the board's orientation.
		if (!api.getActiveTools().includes("backlog")) return undefined;
		return content ? { message: { customType: BACKLOG_DIGEST_TYPE, content, display: false } } : undefined;
	});
}
