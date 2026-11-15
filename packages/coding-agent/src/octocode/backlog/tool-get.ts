import { visibleControls } from "../../../../common/src/sanitize.ts";
import { textResult } from "../shared/util.ts";
import type { Backlog } from "./context.ts";
import { AUDIT_SHOWN, auditText } from "./audit-text.ts";
import { itemDetail } from "./format.ts";
import { MAX_LIST_LIMIT } from "./tool-list.ts";
import type { BacklogAudit } from "@octocodeai/octocode-contracts/snapshot";

export interface GetParams {
	id: string;
	offset?: number;
	limit?: number;
	/** Also show the changes the store logged on its own (state, assignee, fields); notes only by default. */
	changes?: boolean;
}

/**
 * `get` one item: its fields, items, steps, runs and the newest notes (default 10, paged by `limit` and `offset`). The
 * store's own change rows and the audit trail fill half a typical item's history, so they show only with `changes`;
 * the web board reads them from the snapshot.
 */
export function getResult(backlog: Backlog, params: GetParams, audits?: BacklogAudit[]): ReturnType<typeof textResult> {
	const { store, actor } = backlog;
	const item = store.get(params.id);
	if (!item) throw new Error(`No backlog item ${visibleControls(params.id)}.`);
	const offset = Math.max(0, Math.floor(params.offset ?? 0));
	const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(params.limit ?? 10)));
	const kind = params.changes ? undefined : "note";
	const total = store.noteCount(item, kind);
	const notes = store.notes(item, limit, offset, kind);
	const origin = item.from === undefined ? undefined : store.get(item.from);
	const derived = store.derived(item);
	const children = item.type === "epic" ? store.list({ parentId: item.ref }).items : [];
	const detail = itemDetail(item, notes, total, Date.now(), {
		self: actor.id,
		version: true,
		noteOffset: offset,
		notesOnly: !params.changes,
		...(actor.owners ? { parents: actor.owners } : {}),
		...(origin ? { origin } : {}),
		derived,
		children,
		marks: store.marks([item, ...(origin ? [origin] : []), ...derived, ...children], actor.id, actor.owners),
		tasks: store.tasks.list({ item: item.ref }),
		runs: store.runs(item),
		epicState: store.epicState(item),
	});
	const more = {
		op: "get",
		id: item.ref,
		limit,
		offset: offset + notes.length,
		...(params.changes ? { changes: true } : {}),
	};
	const next = offset + notes.length < total ? `\nNext: backlog ${JSON.stringify(more)}` : "";
	const audit = params.changes ? auditText(audits ?? store.audit(item.ref, AUDIT_SHOWN)) : "";
	return textResult(`${detail}${audit}${next}`, { item });
}
