import { ManagePageComponent, type ManagePageOptions } from "../../../theme/manage-page.ts";
import { confirmAction as confirmChoice, type PageChoice, successNotice } from "../../../octocode/shared/page.ts";
import type { ProviderManagerHost } from "./provider-manager-host.ts";

/** Show a page and resolve with the user's choice, or undefined when they pressed Escape. The page closes first. */
export function showPage(
	host: Pick<ProviderManagerHost, "showSelector" | "ui">,
	options: Omit<ManagePageOptions, "onSelect" | "onKey" | "onCancel">,
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
			});
			return { component: page, focus: page };
		});
	});
}

/** The one confirmation (`Cancel` first), asked through the extension selector. */
export function confirmAction(
	host: Pick<ProviderManagerHost, "showExtensionSelector">,
	question: string,
	actions: readonly string[],
): Promise<string | undefined> {
	return confirmChoice((title, options) => host.showExtensionSelector(title, options), question, actions);
}

export { successNotice };
