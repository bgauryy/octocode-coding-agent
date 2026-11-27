import { type ReactNode, useRef } from "react";
import { useModal } from "../hooks.ts";
import { cx } from "./primitives.tsx";

/** A side sheet in the style of an issue peek: modal, labelled by its heading, dismissed by Escape or the backdrop. */
export function Sheet({
	labelledBy,
	label,
	onClose,
	initialFocus,
	focusKey,
	wide,
	children,
}: {
	labelledBy?: string;
	label?: string;
	onClose: () => void;
	initialFocus?: () => HTMLElement | null;
	focusKey?: string;
	wide?: boolean;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useModal(ref, onClose, initialFocus, focusKey);
	return (
		<>
			{/* A pointer shortcut, hidden from assistive technology: Escape and the Close button are the accessible paths. */}
			<div className="backdrop" id="backdrop" aria-hidden="true" onClick={onClose} />
			<dialog
				open
				ref={ref}
				id="drawer"
				className={cx("sheet", wide && "sheet-wide")}
				aria-modal="true"
				aria-labelledby={labelledBy}
				aria-label={labelledBy ? undefined : label}
				tabIndex={-1}
			>
				{children}
			</dialog>
		</>
	);
}
