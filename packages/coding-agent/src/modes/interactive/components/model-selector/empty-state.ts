import type { ModelRuntime } from "../../../../core/model-runtime.ts";
import { noMatchMessage } from "../../../../theme/theme-tui-helpers.ts";

type Runtime = Pick<ModelRuntime, "getDefinedProviderIds" | "hasConfiguredAuth">;

/**
 * What an empty model list says. A search that matched nothing names it; a list empty because nothing is connected says
 * where to connect, and names the providers models.json defines that still have no key (they list no models until then).
 * The list cuts its one empty line to the width, so `/providers` comes first: it still shows at 40 columns.
 */
export function emptyModelListText(runtime: Runtime, query = ""): string {
	if (query.trim()) return noMatchMessage("models", query);
	const keyless = runtime.getDefinedProviderIds().filter((id) => !runtime.hasConfiguredAuth(id));
	const shown = keyless.slice(0, 4).join(", ");
	const more = keyless.length > 4 ? ` and ${keyless.length - 4} more` : "";
	return keyless.length > 0
		? `No models: add a key in /providers; models.json defines ${shown}${more} without one.`
		: "No models: open /providers to connect one (account sign-in, API key or external agent).";
}
