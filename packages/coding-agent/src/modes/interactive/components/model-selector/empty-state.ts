import type { ModelRuntime } from "../../../../core/model-runtime.ts";
import { noMatchMessage } from "../../../../theme/theme-tui-helpers.ts";

type Runtime = Pick<ModelRuntime, "getDefinedProviderIds" | "hasConfiguredAuth">;

/**
 * What an empty model list says. A search that matched nothing names it; a list empty because nothing is connected says
 * where to connect, and names the providers models.json defines that still have no key (they list no models until then).
 */
export function emptyModelListText(runtime: Runtime, query = ""): string {
	if (query.trim()) return noMatchMessage("models", query);
	const keyless = runtime.getDefinedProviderIds().filter((id) => !runtime.hasConfiguredAuth(id));
	const shown = keyless.slice(0, 4).join(", ");
	const more = keyless.length > 4 ? ` and ${keyless.length - 4} more` : "";
	return keyless.length > 0
		? `No models yet: models.json defines ${shown}${more} without a key. Add one in /providers.`
		: "No models yet: connect a provider in /providers (account sign-in, API key or external agent).";
}
