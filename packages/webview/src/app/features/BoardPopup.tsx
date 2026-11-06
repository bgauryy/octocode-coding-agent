import { type ReactNode, useRef } from "react";
import { useModal } from "../hooks.ts";

/** A small modal for one short question on the board (a note, a confirmation, the Close form): Escape and the backdrop dismiss it. */
export function BoardPopup({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
	const ref = useRef<HTMLDialogElement>(null);
	useModal(ref, onClose, () => ref.current?.querySelector<HTMLElement>("textarea, input, select, button") ?? null);
	return (
		<>
			{/* A pointer shortcut, hidden from assistive technology: Escape and the Cancel button are the accessible paths. */}
			<div className="backdrop" aria-hidden="true" onClick={onClose} />
			<dialog open ref={ref} className="popup" aria-modal="true" aria-label={label} tabIndex={-1}>
				{children}
			</dialog>
		</>
	);
}
