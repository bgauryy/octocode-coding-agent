import {
	animationClock,
	type Component,
	GLYPH,
	MOTION,
	SPINNER,
	truncateToWidth,
	type TUI,
} from "@octocodeai/octocode-tui";
import type { Theme } from "../../theme/theme.ts";
import { formatDuration } from "../shared/format.ts";
import { isPendingPhase, phaseWords, type SessionPhase, type SessionPhaseStore } from "../shared/session-phase.ts";

/** The live line animates while the session waits on running work or a wake; a timer only counts down. */
const animates = (phase: SessionPhase) => phase.state === "waiting" || phase.state === "resuming";

/**
 * `⠹ Waiting on 4 agents · 1 bash (4m02s)`: one line above the editor, where the host's working indicator sits during a
 * run. It draws the phase (never shown during a run of the session's own: the host indicator does) and the job's clock,
 * and repaints on the animation clock: the working spinner's frames (a full ⏺ in reduced motion) and the second
 * counter.
 */
export function phaseLine(tui: Pick<TUI, "requestRender">, theme: Theme, store: SessionPhaseStore) {
	let frame = 0;
	const text = (): string | undefined => {
		const phase = store.phase();
		const now = Date.now();
		const words = isPendingPhase(phase) ? phaseWords(phase, now) : undefined;
		if (words === undefined) return undefined;
		const started = store.jobStartedAt();
		return `${words}${started === undefined ? "" : ` (${formatDuration(now - started)})`}`;
	};
	let shown = text();
	const stopSpinner = animationClock.subscribe(
		() => {
			if (!animates(store.phase())) return;
			frame = (frame + 1) % SPINNER.braille.length;
			tui.requestRender();
		},
		{ everyMs: MOTION.backgroundSpinnerMs, kind: "decor" },
	);
	const stopClock = animationClock.subscribe(
		() => {
			const next = text();
			if (next === shown) return;
			shown = next;
			tui.requestRender();
		},
		{ everyMs: MOTION.tickMs, kind: "info" },
	);
	const component: Component & { dispose(): void } = {
		render(width: number): string[] {
			const words = text();
			if (words === undefined) return [];
			const phase = store.phase();
			const still = !animates(phase) || animationClock.isReducedMotion();
			const mark = animates(phase) ? (still ? GLYPH.light : SPINNER.braille[frame]) : GLYPH.waiting;
			const color = phase.state === "waiting" ? "accent" : "muted";
			return ["", truncateToWidth(` ${theme.fg(color, mark)} ${theme.fg("muted", words)}`, Math.max(0, width), "…")];
		},
		invalidate: () => undefined,
		dispose(): void {
			stopSpinner();
			stopClock();
		},
	};
	return component;
}
