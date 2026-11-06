import { type ReactNode, useEffect, useRef } from "react";
import { cx } from "../ui/primitives.tsx";

/**
 * A button that opens a panel: a native `details`, closed by Escape (focus returns to the button), by a click outside,
 * and after a click on an element marked `data-menu-item`. The panel's children stay mounted while it is closed.
 */
export function Popover({
	summary,
	label,
	title,
	className,
	panelClassName,
	children,
}: {
	summary: ReactNode;
	label?: string;
	title?: string;
	className?: string;
	panelClassName?: string;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDetailsElement>(null);
	useEffect(() => {
		const close = (event: Event) => {
			const menu = ref.current;
			if (!menu?.open) return;
			if (event.type === "keydown") {
				if ((event as KeyboardEvent).key !== "Escape") return;
				menu.querySelector("summary")?.focus();
			} else if (event.target instanceof Node && menu.contains(event.target)) return;
			menu.open = false;
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", close);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", close);
		};
	}, []);
	return (
		<details className="menu-pop" ref={ref}>
			<summary className={cx("btn", className)} aria-label={label} title={title}>
				{summary}
			</summary>
			{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- delegates a click on a real button inside; the keyboard activates that button */}
			<div
				className={cx("menu-panel", panelClassName)}
				onClick={(event) => {
					if (event.target instanceof Element && event.target.closest("[data-menu-item]") && ref.current)
						ref.current.open = false;
				}}
			>
				{children}
			</div>
		</details>
	);
}
