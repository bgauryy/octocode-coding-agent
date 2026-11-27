import { isRecord } from "@octocodeai/octocode-contracts/guards";

export type SessionDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
interface SavedDraft {
	text: string;
	to?: string;
}
const STORAGE_KEY = "octocode-session-drafts-v1";
const DRAFT_PREFIX = "session-command:";
const MAX_DRAFTS = 10;
const MAX_TEXT = 64 * 1024;
const MAX_TOTAL_TEXT = 256 * 1024;
const SESSION_ID = /^[\w.-]{1,128}$/;

function browserStorage(): SessionDraftStorage | undefined {
	try {
		return globalThis.sessionStorage;
	} catch {
		return undefined;
	}
}

const PERSIST_DELAY_MS = 400;
/** Instances with unsaved edits; one pair of page listeners flushes them when the tab hides or unloads. */
const dirty = new Set<{ flush(): void }>();
let listening = false;
function flushAll(): void {
	for (const drafts of dirty) drafts.flush();
}
function listenOnce(): void {
	if (listening || typeof globalThis.addEventListener !== "function") return;
	listening = true;
	globalThis.addEventListener("pagehide", flushAll);
	globalThis.addEventListener("visibilitychange", () => {
		if (globalThis.document?.visibilityState === "hidden") flushAll();
	});
}

/**
 * Only unsent composer text and its mode survive navigation in this tab; never attachments or request credentials.
 * Writes are held for a short pause in typing (the last edit per session wins) so a keystroke does not parse and
 * rewrite every saved draft; `read` and a hidden or closing tab flush first.
 */
export function createSessionDrafts(storage = browserStorage()) {
	const pending = new Map<string, { text: string; to?: string } | null>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	function saved(): Map<string, SavedDraft> {
		try {
			const raw = storage?.getItem(STORAGE_KEY);
			if (!raw || raw.length > MAX_TOTAL_TEXT * 6 + 4096) return new Map();
			const entries: unknown = JSON.parse(raw);
			if (!Array.isArray(entries) || entries.length > MAX_DRAFTS) return new Map();
			const result = new Map<string, SavedDraft>();
			let total = 0;
			for (const entry of entries) {
				if (!Array.isArray(entry) || entry.length !== 2) continue;
				const [id, draft] = entry;
				if (
					typeof id !== "string" ||
					!SESSION_ID.test(id) ||
					!isRecord(draft) ||
					typeof draft.text !== "string" ||
					!draft.text.trim() ||
					draft.text.length > MAX_TEXT
				)
					continue;
				total += draft.text.length;
				if (total > MAX_TOTAL_TEXT) return new Map();
				const to = ["prompt", "steer", "followUp"].includes(String(draft.to)) ? String(draft.to) : undefined;
				result.set(id, { text: draft.text, ...(to ? { to } : {}) });
			}
			return result;
		} catch {
			return new Map();
		}
	}
	function flush(): void {
		clearTimeout(timer);
		timer = undefined;
		dirty.delete(api);
		if (!pending.size) return;
		const edits = [...pending];
		pending.clear();
		try {
			const drafts = saved();
			for (const [id, draft] of edits) {
				drafts.delete(id);
				// Oversized drafts stay editable in memory; do not silently restore a truncated message after navigation.
				if (draft?.text.trim() && draft.text.length <= MAX_TEXT) {
					const to = ["prompt", "steer", "followUp"].includes(draft.to ?? "") ? draft.to : undefined;
					drafts.set(id, { text: draft.text, ...(to ? { to } : {}) });
				}
			}
			let total = [...drafts.values()].reduce((sum, item) => sum + item.text.length, 0);
			while (drafts.size > MAX_DRAFTS || total > MAX_TOTAL_TEXT) {
				const oldest = drafts.keys().next().value;
				if (oldest === undefined) break;
				total -= drafts.get(oldest)!.text.length;
				drafts.delete(oldest);
			}
			if (drafts.size) storage?.setItem(STORAGE_KEY, JSON.stringify([...drafts]));
			else storage?.removeItem(STORAGE_KEY);
		} catch {
			/* Storage is optional: disabled storage or a full quota must not interrupt typing. */
		}
	}
	const api = {
		flush,
		read(sessionId?: string) {
			flush();
			return Object.fromEntries(
				[...saved()]
					.filter(([id]) => sessionId === undefined || id === sessionId)
					.map(([id, draft]) => [DRAFT_PREFIX + id, { ...draft, id: crypto.randomUUID() }]),
			);
		},
		write(key: string, draft: { text: string; to?: string } | null): void {
			if (!key.startsWith(DRAFT_PREFIX)) return;
			const id = key.slice(DRAFT_PREFIX.length);
			if (!SESSION_ID.test(id)) return;
			pending.delete(id); // the newest edit is also the newest draft for eviction order
			pending.set(id, draft);
			dirty.add(api);
			listenOnce();
			clearTimeout(timer);
			timer = setTimeout(flush, PERSIST_DELAY_MS);
		},
	};
	return api;
}
