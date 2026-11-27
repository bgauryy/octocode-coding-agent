import { ManagePageComponent, type ManagePageOptions } from "../../../theme/manage-page.ts";
import { confirmAction as confirmChoice, type PageChoice, successNotice } from "../../../octocode/shared/page.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";

/**
 * Show a page and resolve with the user's choice, or undefined when they pressed Escape. The page closes first.
 * `closesOn` names keys that close the page as Escape does; the page then hands the key to `onClosed`.
 */
export function showPage(
	host: Pick<ProviderManagerHost, "showSelector" | "ui">,
	options: Omit<ManagePageOptions, "onSelect" | "onKey" | "onCancel" | "onInput">,
	closesOn?: { test(data: string): boolean; onClosed(data: string): void },
): Promise<PageChoice | undefined> {
	return new Promise((resolve) => {
		host.showSelector((done) => {
			const finish = (choice: PageChoice | undefined) => {
				done();
				resolve(choice);
			};
			const page = new ManagePageComponent({
				viewportRows: () => host.ui.terminal.rows - 1,
				...options,
				onSelect: (id) => finish({ id }),
				onKey: (key, id) => finish({ id, key }),
				onCancel: () => finish(undefined),
				...(closesOn
					? {
							onInput: (data: string) => {
								if (!closesOn.test(data)) return false;
								finish(undefined);
								closesOn.onClosed(data);
								return true;
							},
						}
					: {}),
			});
			return { component: page, focus: page };
		});
	});
}

/** The one confirmation (`Cancel` first), asked through the feature selector. */
export function confirmAction(
	host: Pick<ProviderManagerHost, "showSelectorDialog">,
	question: string,
	actions: readonly string[],
): Promise<string | undefined> {
	return confirmChoice((title, options) => host.showSelectorDialog(title, options), question, actions);
}

export { successNotice };
