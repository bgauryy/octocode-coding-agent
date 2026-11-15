import { BacklogError, type Actor, type BacklogStore, type Item } from "./store.ts";

/** The note a graceful exit leaves on each item it returns; the same text is how a resume recognises it. */
const exitNote = (session: string) => `Returned to todo: holder ${session} ended. Resuming ${session} restores it.`;

/** Todo items read, most recently updated first, to find what an exit released: a released item has not been touched since. */
const RESTORE_SCAN = 200;

/**
 * A session that ends gracefully (not a reload, which continues) returns its own ongoing items to todo, except those a
 * child run works on (`marks.workers`, a lingering child included). Returns the refs released.
 */
export function releaseOwn(store: BacklogStore, actor: Actor): string[] {
	const items = store.list({ states: ["ongoing"], assignees: [actor.id] }).items;
	const marks = store.marks(items, actor.id);
	const released: string[] = [];
	for (const item of items) {
		if (marks.get(item.ref)?.workers?.length) continue;
		try {
			store.update(item.ref, { state: "todo", note: exitNote(actor.id), version: item.version }, actor);
			released.push(item.ref);
		} catch (error) {
			// Another session changed the item meanwhile: it stands as it is.
			if (!(error instanceof BacklogError)) throw error;
		}
	}
	return released;
}

/** Whether nothing touched `item` after the exit of `session` released it: its newest note is that release and it was the last change. */
function untouchedSinceExit(store: BacklogStore, item: Item, session: string): boolean {
	const latest = store.notes(item, 1)[0];
	return item.state === "todo" && latest?.text === exitNote(session) && latest.at === item.updatedAt;
}

/**
 * The session started again (a resume, or a continued start): the items its exit released and nobody touched since go
 * back to ongoing for it. An item touched or claimed by anyone else stays as it is. Returns the refs restored.
 */
export function restoreOwn(store: BacklogStore, actor: Actor): string[] {
	const restored: string[] = [];
	for (const item of store.list({ states: ["todo"], sort: "updated", limit: RESTORE_SCAN }).items) {
		if (!untouchedSinceExit(store, item, actor.id)) continue;
		try {
			store.update(
				item.ref,
				{ state: "ongoing", note: `Restored: holder ${actor.id} resumed.`, version: item.version },
				actor,
			);
			restored.push(item.ref);
		} catch (error) {
			if (!(error instanceof BacklogError)) throw error;
		}
	}
	return restored;
}
