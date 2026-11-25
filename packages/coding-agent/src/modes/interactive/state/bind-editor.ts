/**
 * Binds the editor slice to the editor component: when the border tone changes, the editor border fades to the new
 * tone's color and the active status indicator is repainted. `applyEditorBorder` also serves the theme change, which
 * keeps the tone but changes its color, and paints at once.
 */

import { animationClock, type Color, MOTION, mixColors, watchSelection } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import type { InteractiveModeHost } from "../interactive-mode/host.ts";
import { selectEditorBorder, type EditorBorderTone } from "./editor-slice.ts";

type BindEditorHost = Pick<InteractiveModeHost, "activeStatusIndicator" | "editor" | "ui" | "uiStore">;

/** The fade in progress for a host's editor border: the color it shows now and how to stop it. */
const fades = new WeakMap<BindEditorHost, { shown: Color; stop: () => void }>();

function paintBorder(host: BindEditorHost, color: (text: string) => string): void {
	host.editor.borderColor = color;
	host.activeStatusIndicator?.invalidate();
}

function stopFade(host: BindEditorHost): void {
	fades.get(host)?.stop();
	fades.delete(host);
}

/** Paints the editor border for `tone` at once, ending any fade. */
export function applyEditorBorder(host: BindEditorHost, tone: EditorBorderTone): void {
	stopFade(host);
	paintBorder(host, tone === "bash" ? theme.getBashModeBorderColor() : theme.getThinkingBorderColor(tone));
}

/** Can a border fade show here: colors that mix, and motion allowed. */
function canFade(): boolean {
	const mode = theme.getColorMode();
	return (mode === "truecolor" || mode === "256color") && !animationClock.isReducedMotion();
}

/**
 * Fades the editor border from `from` (or the color a fade in progress shows) to `tone` over `MOTION.fadeMs`, then
 * paints the tone's own painter, so the settled border is exactly what `applyEditorBorder` draws.
 */
function fadeEditorBorder(host: BindEditorHost, from: EditorBorderTone, tone: EditorBorderTone): void {
	if (!canFade()) {
		applyEditorBorder(host, tone);
		host.ui.requestRender();
		return;
	}
	const colors = theme.colors;
	const start = fades.get(host)?.shown ?? colors[theme.getEditorBorderToken(from)];
	const end = colors[theme.getEditorBorderToken(tone)];
	stopFade(host);
	const fade = { shown: start, stop: () => {} };
	const startedAt = Date.now();
	const step = (now: number): void => {
		const progress = (now - startedAt) / MOTION.fadeMs;
		// Reduced motion turned on mid-fade freezes decoration: settle instead of holding a mixed color.
		if (progress >= 1 || !canFade()) {
			applyEditorBorder(host, tone);
			host.ui.requestRender();
			return;
		}
		// Ease out: most of the change shows in the first frames.
		const shown = mixColors(start, end, 1 - (1 - progress) ** 2);
		fade.shown = shown;
		paintBorder(host, (text) => theme.style(text, { fg: shown }));
		host.ui.requestRender();
	};
	fades.set(host, fade);
	fade.stop = animationClock.subscribe(step, { everyMs: MOTION.fadeFrameMs, kind: "decor" });
	step(startedAt);
}

/** Starts following the editor slice; returns the function that stops it and any fade in progress. */
export function bindEditorState(host: BindEditorHost): () => void {
	const unwatch = watchSelection(host.uiStore, selectEditorBorder, (tone, from) => fadeEditorBorder(host, from, tone));
	return () => {
		unwatch();
		stopFade(host);
	};
}
