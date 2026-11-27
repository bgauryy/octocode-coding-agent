import { useCallback, useEffect, useState } from "react";
import { Toast, type ToastMessage } from "../features/Toast.tsx";
import { NoticeToasts } from "./notice-toasts.ts";
import { useLive } from "./session.tsx";

/**
 * The session's notices (what the terminal said with `ui.notify`) as a transient toast on any view; the activity feed
 * keeps them as lines. An error stays until dismissed. Inside `Provider`.
 */
export function SessionNotices() {
	const live = useLive();
	const [toast, setToast] = useState<ToastMessage>();
	useEffect(() => {
		const toasts = new NoticeToasts();
		let count = 0;
		const check = () => {
			const next = toasts.next(live.session.getState().application);
			if (next) setToast({ id: ++count, text: next.text, tone: next.level === "error" ? "error" : "info" });
		};
		check();
		return live.session.subscribe(check);
	}, [live]);
	const dismiss = useCallback(() => setToast(undefined), []);
	return toast ? <Toast toast={toast} onDismiss={dismiss} /> : null;
}
