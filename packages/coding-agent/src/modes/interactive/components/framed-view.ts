/** A bordered, full-width manager view whose content a command rebuilds while it runs (`/mcp`, `/llama`). */

import {
	type Component,
	Container,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@octocodeai/octocode-tui";
import type { ExtensionCommandContext } from "../../../core/features/types.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import type { Theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/** An accent-bordered screen: the bold title, the body and an optional dim footer line. */
export function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	for (const child of body) container.addChild(child);
	if (footer) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return container;
}

/** `content` rendered at `width`, with any wider line cut to fit. */
export function renderClipped(content: Component, width: number): string[] {
	return content.render(width).map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
}

/**
 * Shows the view `create` builds and runs `run` with it until it returns; an error is reported as a notification.
 * The view closes when `run` settles. When something else takes its slot first (a dialog, a selector, a session reset),
 * the view's `dispose()` runs and this returns while `run` may still wait on the view: a view that waits for input
 * must settle that wait and drop its subscriptions in `dispose()`.
 */
export async function runInView<V extends Component>(
	ctx: ExtensionCommandContext,
	create: (tui: TUI, theme: Theme, keybindings: KeybindingsManager) => V,
	run: (view: V) => Promise<void>,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const view = create(tui, theme, keybindings);
		void (async () => {
			try {
				await run(view);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
			done();
		})();
		return view;
	});
}
