/**
 * The list → detail → action pieces every managing command shares (commands design §3): a page shown through the
 * command's UI, the one confirmation and the one success notice. `/providers` reaches the same helpers through
 * `modes/interactive/interactive-mode/provider-ui.ts`.
 */

import type { ExtensionUIContext } from "../../core/features/index.ts";
import type { ManagePageOptions } from "../../theme/manage-page.ts";

export type { PageRow, PageSection } from "../../theme/manage-page.ts";

/** What the user did on a page: opened a row (Enter) or pressed one of the page's keys on it. */
export interface PageChoice {
	id: string;
	key?: string;
}

/**
 * Show a page through `ui.custom` and resolve with the user's choice, or undefined when they pressed Escape. The page
 * component loads on first use: it paints with the terminal UI package, which a headless session never loads.
 */
export async function showCommandPage(
	ui: Pick<ExtensionUIContext, "custom">,
	options: Omit<ManagePageOptions, "onSelect" | "onKey" | "onCancel">,
): Promise<PageChoice | undefined> {
	const { ManagePageComponent } = await import("../../theme/manage-page.ts");
	return ui.custom<PageChoice | undefined>((tui, _theme, _keybindings, done) => {
		const page = new ManagePageComponent({
			viewportRows: () => tui.terminal.rows - 1,
			...options,
			onSelect: (id) => done({ id }),
			onKey: (key, id) => done({ id, key }),
			onCancel: () => done(undefined),
		});
		const handleInput = page.handleInput.bind(page);
		page.handleInput = (data) => {
			handleInput(data);
			tui.requestRender();
		};
		return page;
	});
}

/**
 * The one confirmation for destructive or replacing actions: a question, `Cancel` first, then the action with what stays
 * unchanged. Returns the chosen action, or undefined when the user cancelled.
 */
export async function confirmAction(
	choose: (title: string, options: string[]) => Promise<string | undefined>,
	question: string,
	actions: readonly string[],
): Promise<string | undefined> {
	const choice = await choose(question, ["Cancel", ...actions]);
	return choice && choice !== "Cancel" && actions.includes(choice) ? choice : undefined;
}

/** The one success notice: a past-tense verb, the thing it applied to and what did not change. */
export function successNotice(verb: string, name: string, unchanged?: string): string {
	return `${verb} ${name}.${unchanged ? ` ${unchanged}` : ""}`;
}
