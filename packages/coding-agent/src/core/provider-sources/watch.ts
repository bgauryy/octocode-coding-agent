import type { ModelRuntime } from "../model-runtime.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { applyProviderSources } from "./apply.ts";

/**
 * Apply the provider switches (`disabledProviders`, `providerSources`) another process saves, as `/reload` does for
 * these two keys and nothing else. `onApplied` runs once the runtime offers the new set. Returns the stop function.
 */
export function watchProviderSettings(
	settings: SettingsManager,
	runtime: ModelRuntime,
	onApplied: () => void,
): () => void {
	return settings.watchProviderToggles(() => {
		runtime.setDisabledProviders(settings.getDisabledProviders());
		applyProviderSources(runtime, settings.getProviderSources())
			.then(onApplied)
			.catch(() => {});
	});
}
