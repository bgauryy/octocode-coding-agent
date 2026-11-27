import { useEffect } from "react";

export interface ToastMessage {
	id: number;
	text: string;
	tone: "info" | "error";
	undo?: { label: string; run: () => void };
}

const AUTO_DISMISS_MS = 9000;

/** A transient notice at the bottom of the board. Errors stay until dismissed; a notice goes after a few seconds. */
export function Toast({ toast, onDismiss }: { toast: ToastMessage; onDismiss: () => void }) {
	useEffect(() => {
		if (toast.tone === "error") return;
		const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
		return () => clearTimeout(timer);
	}, [toast.id, toast.tone, onDismiss]);
	return (
		<div className={`toast toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"}>
			<span>{toast.text}</span>
			{toast.undo && (
				<button
					type="button"
					className="toast-action"
					onClick={() => {
						toast.undo?.run();
						onDismiss();
					}}
				>
					{toast.undo.label}
				</button>
			)}
			<button type="button" className="toast-dismiss" aria-label="Dismiss" onClick={onDismiss}>
				×
			</button>
		</div>
	);
}
