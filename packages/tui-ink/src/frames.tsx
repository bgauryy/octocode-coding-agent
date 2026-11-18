import type { Component } from "@octocodeai/octocode-tui";
import { Box, Static, Text } from "ink";
import { type ReactNode, useRef, useState } from "react";
import { parseWheel, useInputHandler } from "./input.tsx";
import { useColumns, useLegacyLines, useRows } from "./legacy.tsx";
import type { RenderSignal } from "./render-signal.ts";

interface FrameProps {
	/** The old renderer's whole frame: transcript, editor and everything below it. */
	readonly component: Component;
	readonly signal: RenderSignal;
	/** Rendered under the frame; `footerRows` is its height. */
	readonly footer?: ReactNode;
	readonly footerRows?: number;
}

interface Chunk {
	readonly id: number;
	readonly text: string;
}

/**
 * Inline screen: rows that scroll above the live area go to `<Static>` once (native scrollback); the live area stays
 * shorter than the terminal, because Ink clears the screen for a frame taller than it.
 */
export function InlineFrame({ component, signal, footer, footerRows = 0 }: FrameProps): ReactNode {
	const columns = useColumns();
	const rows = useRows();
	const lines = useLegacyLines(component, signal, columns);
	const committed = useRef(0);
	const chunks = useRef<readonly Chunk[]>([]);
	// Rows already in scrollback stay there when the frame shrinks (a cleared transcript).
	if (lines.length < committed.current) committed.current = lines.length;
	const liveRows = Math.max(1, rows - 1 - footerRows);
	const cut = lines.length - liveRows;
	if (cut > committed.current) {
		const text = lines.slice(committed.current, cut).join("\n");
		chunks.current = [...chunks.current, { id: chunks.current.length, text }];
		committed.current = cut;
	}
	const live = lines.slice(committed.current);
	return (
		<>
			<Static items={chunks.current as Chunk[]}>{(chunk) => <Text key={chunk.id}>{chunk.text}</Text>}</Static>
			{live.length > 0 ? <Text>{live.join("\n")}</Text> : null}
			{footer}
		</>
	);
}

/** Fullscreen: exactly the terminal's height, the frame's bottom rows by default; the wheel scrolls back. */
export function FullscreenFrame({ component, signal, footer, footerRows = 0 }: FrameProps): ReactNode {
	const columns = useColumns();
	const rows = useRows();
	const lines = useLegacyLines(component, signal, columns);
	const [back, setBack] = useState(0);
	const viewRows = Math.max(1, rows - footerRows);
	const maxBack = Math.max(0, lines.length - viewRows);
	useInputHandler((data) => {
		const step = parseWheel(data);
		if (step === undefined) return false;
		setBack((value) => Math.min(maxBack, Math.max(0, value - step * 3)));
		return true;
	});
	const end = lines.length - Math.min(back, maxBack);
	const view = lines.slice(Math.max(0, end - viewRows), end);
	return (
		<Box flexDirection="column" height={rows} width={columns}>
			<Box flexDirection="column" height={viewRows} justifyContent="flex-end">
				<Text>{view.join("\n")}</Text>
			</Box>
			{footer}
		</Box>
	);
}
