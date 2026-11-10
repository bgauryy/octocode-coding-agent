import type { ModelRuntime } from "../model-runtime.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { applyProviderSources } from "./apply.ts";
import { noticeDisabledProvider, type ProviderNoticeSession } from "./notice.ts";

const appliedListeners = new WeakMap<object, Set<() => void>>();

/** Calls `listener` after a provider switch another process saved took effect in `session`. Returns the unsubscribe function. */
export function onProviderSettingsApplied(session: object, listener: () => void): () => void {
	const listeners = appliedListeners.get(session) ?? new Set<() => void>();
	appliedListeners.set(session, listeners);
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Apply the provider switches (`disabledProviders`, `providerSources`) another process saves, as `/reload` does for
 * these two keys and nothing else. A session whose model is on a provider just disabled is told at its next turn. Listeners of `onProviderSettingsApplied(session)` run once the runtime offers the new set. Returns the stop function.
 */
export function watchProviderSettings(
	settings: SettingsManager,
	runtime: ModelRuntime,
	session: ProviderNoticeSession,
): () => void {
	return settings.watchProviderToggles(() => {
		runtime.setDisabledProviders(settings.getDisabledProviders());
		noticeDisabledProvider(session);
		applyProviderSources(runtime, settings.getProviderSources())
			.then(() => {
				for (const listener of appliedListeners.get(session) ?? []) listener();
			})
			.catch(() => {});
	});
}
