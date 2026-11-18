import type { Component } from "@octocodeai/octocode-tui";
import { Text, useStdout } from "ink";
import { type ReactNode, useSyncExternalStore } from "react";
import type { RenderSignal } from "./render-signal.ts";

/** The terminal width Ink lays out at; 80 when the stream reports none. */
export function useColumns(): number {
	const columns = (useStdout().stdout as { columns?: number }).columns ?? 0;
	return columns > 0 ? columns : 80;
}

export function useRows(): number {
	const rows = (useStdout().stdout as { rows?: number }).rows ?? 0;
	return rows > 0 ? rows : 24;
}

/** A legacy component's rows at `width`, read again at each `signal` (the old renderer's paint request). */
export function useLegacyLines(component: Component, signal: RenderSignal, width: number): readonly string[] {
	useSyncExternalStore(signal.subscribe, signal.version);
	return component.render(width);
}

/**
 * Shows a component of the old renderer (`render(width)` rows, ANSI kept) inside Ink and paints it again whenever the
 * old renderer would have. Temporary: removed once every component is ported.
 */
export function Legacy({
	component,
	signal,
	width,
}: {
	component: Component;
	signal: RenderSignal;
	width?: number;
}): ReactNode {
	const columns = useColumns();
	const lines = useLegacyLines(component, signal, width ?? columns);
	return lines.length === 0 ? null : <Text>{lines.join("\n")}</Text>;
}
