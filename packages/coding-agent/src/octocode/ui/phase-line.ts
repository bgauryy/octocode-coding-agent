import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { isPendingPhase, sessionPhaseOf } from "../shared/session-phase.ts";
import { registerPhaseFeed } from "./phase-feed.ts";
import type * as PhaseLineView from "./phase-line-view.ts";

/** The widget's key. */
const WIDGET_KEY = "octocode-phase";

/**
 * Shows the phase line in the TUI while the session waits (agents, bash, a wake or a timer) with no run of its own, and
 * takes it away when a run starts or the job ends.
 */
export function registerPhaseLine(api: FeatureSetup): void {
	registerPhaseFeed(api);
	const store = sessionPhaseOf(api);
	let ctx: FeatureContext | undefined;
	let mounted = false;
	let repaint: (() => void) | undefined;
	let unsubscribe: (() => void) | undefined;
	// The view draws with the terminal UI kit: loaded on the first TUI session, so a headless session never reaches it.
	let view: typeof PhaseLineView | undefined;
	const sync = () => {
		if (!ctx || !view) return;
		const { phaseLine } = view;
		const show = isPendingPhase(store.phase());
		if (show && !mounted) {
			mounted = true;
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					repaint = () => tui.requestRender();
					return phaseLine(tui, theme, store);
				},
				{ placement: "aboveEditor" },
			);
		} else if (!show && mounted) {
			mounted = false;
			repaint = undefined;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} else if (show) repaint?.();
	};
	const leave = (current: FeatureContext | undefined) => {
		unsubscribe?.();
		unsubscribe = undefined;
		if (mounted) current?.ui.setWidget(WIDGET_KEY, undefined);
		mounted = false;
		repaint = undefined;
		ctx = undefined;
	};
	api.bus.on("session_start", async (_event, current) => {
		leave(ctx);
		if (current.mode !== "tui" || !current.hasUI) return;
		view ??= await import("./phase-line-view.ts");
		ctx = current;
		unsubscribe = store.subscribe(sync);
		sync();
	});
	api.bus.on("session_shutdown", async (_event, current) => leave(current));
}
