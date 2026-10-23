import { type ReactNode, useRef } from "react";
import { useModal } from "../hooks.ts";
import { cx } from "./primitives.tsx";

/** A side sheet in the style of an issue peek: modal, labelled by its heading, dismissed by Escape or the backdrop. */
export function Sheet({
	labelledBy,
	label,
	onClose,
	initialFocus,
	wide,
	children,
}: {
	labelledBy?: string;
	label?: string;
	onClose: () => void;
	initialFocus?: () => HTMLElement | null;
	wide?: boolean;
	children: ReactNode;
}) {
	const ref = useRef<HTMLElement>(null);
	useModal(ref, onClose, initialFocus);
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; Escape and the Close button are the accessible paths. */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
			<div className="backdrop" id="backdrop" onClick={onClose} />
			<aside
				ref={ref}
				id="drawer"
				className={cx("sheet", wide && "sheet-wide")}
				role="dialog"
				aria-modal="true"
				aria-labelledby={labelledBy}
				aria-label={labelledBy ? undefined : label}
				tabIndex={-1}
			>
				{children}
			</aside>
		</>
	);
}
