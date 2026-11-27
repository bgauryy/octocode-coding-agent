import { type RefObject, useEffect, useRef, useState } from "react";

const DEFAULT_WIDTH = 900;

/** The element's width in pixels, following resizes; a fixed default until it has a size (and in tests). */
export function useWidth(): [RefObject<HTMLElement | null>, number] {
	const ref = useRef<HTMLElement>(null);
	const [width, setWidth] = useState(DEFAULT_WIDTH);
	useEffect(() => {
		const node = ref.current;
		if (!node || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (node.clientWidth > 0) setWidth(node.clientWidth);
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	return [ref, width];
}
