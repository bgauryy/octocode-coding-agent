/**
 * Notices slice of the interactive UI store: the notices the interface says at most once in a host's lifetime, and the
 * changelog the startup notice shows. Nothing draws it, so no binder asks for a frame when it changes.
 */

import type { StoreApi } from "zustand/vanilla";

/** A notice said at most once: the Claude subscription token, the `/bug` hint, the install change, the startup notice. */
export type OnceNotice = "anthropicSubscription" | "bugReportHint" | "installChange" | "startup";

export interface NoticesSlice {
	/** The once-only notices already said; replaced (never mutated) on each change. */
	shown: ReadonlySet<OnceNotice>;
	/** The new changelog entries the startup notice shows; undefined when there are none (or the session resumed). */
	changelog: string | undefined;
}

export interface NoticesActions {
	/** Records `notice` as said and returns true, or returns false when it already was. */
	claimNotice(notice: OnceNotice): boolean;
	setChangelog(markdown: string | undefined): void;
}

export interface NoticesState {
	notices: NoticesSlice;
}

type Get = StoreApi<NoticesState & NoticesActions>["getState"];
type Set = StoreApi<NoticesState & NoticesActions>["setState"];

export const initialNoticesSlice = (init: Partial<NoticesSlice> = {}): NoticesSlice => ({
	shown: new Set(),
	changelog: undefined,
	...init,
});

export const isNoticeShown = (state: NoticesState, notice: OnceNotice): boolean => state.notices.shown.has(notice);
export const selectChangelog = (state: NoticesState): string | undefined => state.notices.changelog;

export function createNoticesActions(set: Set, get: Get): NoticesActions {
	return {
		claimNotice(notice) {
			const { notices } = get();
			if (notices.shown.has(notice)) return false;
			set({ notices: { ...notices, shown: new Set([...notices.shown, notice]) } });
			return true;
		},
		setChangelog(markdown) {
			const { notices } = get();
			if (markdown === notices.changelog) return;
			set({ notices: { ...notices, changelog: markdown } });
		},
	};
}
