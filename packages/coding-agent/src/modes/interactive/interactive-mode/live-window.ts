import { type Component, type Container, ThemedText } from "@octocodeai/octocode-tui";
/**
 * Live transcript window for the main screen. Every row a live session adds would otherwise stay mounted, with its
 * rendered lines and its share of the renderer's row array, for the rest of the session. Rows that scrolled into the
 * terminal's scrollback are the terminal's to keep: once the transcript passes a window, the oldest finished rows above
 * the screen leave it, behind one row that says so. The renderer keeps scrollback for that shrink (it moves its row
 * numbers instead of replaying), so the reader sees nothing change until a replay (a resize, a theme change), which
 * redraws only the rows still mounted. The "load earlier" key rebuilds the transcript from the session as a resume does.
 * Fullscreen has no scrollback and keeps every row.
 */

import { theme } from "../../../theme/theme.ts";
import { keyHint } from "../../../theme/theme-tui-helpers.ts";
import type { InteractiveModeHost } from "./host.ts";
import { disposeComponent } from "./transcript-dispose.ts";

/** Top-level transcript rows a fold keeps mounted. */
const LIVE_WINDOW_ROWS = 400;
/** Rows past the window before a fold: folds come in batches, each one a single repaint of the screen. */
const LIVE_FOLD_BATCH = 200;

type LiveWindowHost = Pick<InteractiveModeHost, "chatContainer" | "pendingTools" | "streamingComponent" | "ui">;

interface Fold {
	row: Component;
	count: number;
}
const folds = new WeakMap<Container, Fold>();

function foldRow(count: number): Component {
	return new ThemedText(
		() =>
			theme.fg("dim", `↑ ${count} earlier rows left in terminal scrollback `) +
			keyHint("app.session.loadEarlier", "to load the transcript"),
		1,
		0,
	);
}

/** The container's fold row, when it still leads the transcript (a rebuild or clear drops it). */
function currentFold(container: Container, children: readonly Component[]): Fold | undefined {
	const fold = folds.get(container);
	return fold && children[0] === fold.row ? fold : undefined;
}

function holdsLive(component: Component, live: ReadonlySet<Component>): boolean {
	if (live.has(component)) return true;
	const children = (component as { children?: Component[] }).children;
	return Array.isArray(children) && children.some((child) => holdsLive(child, live));
}

/**
 * Fold the oldest top-level rows that are finished and wholly above the screen, once more than `keep + batch` follow
 * the fold row; returns how many rows left. Call between turns: rows still streaming or running stay, with every row
 * after them.
 */
export function foldScrolledTranscript(host: LiveWindowHost, keep = LIVE_WINDOW_ROWS, batch = LIVE_FOLD_BATCH): number {
	const { ui, chatContainer, pendingTools, streamingComponent } = host;
	if (!ui.isAboveViewport || !ui.keepScrollbackOnCollapse) return 0;
	const children = chatContainer.children;
	const fold = currentFold(chatContainer, children);
	const start = fold ? 1 : 0;
	if (children.length - start - keep < batch) return 0;
	let cut = children.length - keep;
	const live = new Set<Component>(pendingTools.values());
	if (streamingComponent) live.add(streamingComponent);
	if (live.size > 0) {
		for (let index = start; index < cut; index++) {
			if (holdsLive(children[index], live)) {
				cut = index;
				break;
			}
		}
	}
	// The first kept row started above the screen, so every folded row ended there: the terminal holds all of them.
	while (cut > start && !ui.isAboveViewport(children[cut])) cut--;
	if (cut <= start) return 0;
	const folded = children.slice(start, cut);
	const count = (fold?.count ?? 0) + folded.length;
	const row = foldRow(count);
	chatContainer.children = [row, ...children.slice(cut)];
	folds.set(chatContainer, { row, count });
	for (const component of folded) disposeComponent(component);
	ui.keepScrollbackOnCollapse();
	ui.requestRender();
	return folded.length;
}

/** Whether the transcript has rows a live fold took out. */
export function hasLiveFold(container: Container): boolean {
	return currentFold(container, container.children) !== undefined;
}
