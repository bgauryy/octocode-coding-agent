import type { InteractiveModeHost } from "./host.ts";

/**
 * A live reload of models.json or auth.json that cannot load keeps the providers in use: tell the user why, once per
 * failure. `/providers` keeps showing the reason until a reload succeeds. A reload that removes the provider of the
 * session's current model gets one notice too: the running turn finishes, and the next one needs another model.
 */
export function announceReloadErrors(target: Pick<InteractiveModeHost, "session" | "showWarning">): () => void {
	const { modelRuntime } = target.session;
	const stopErrors = modelRuntime.onReloadError((message) =>
		target.showWarning(`Provider changes were not applied; the previous providers stay loaded. ${message}`),
	);
	const stopRemoved = modelRuntime.onProvidersRemoved((providerIds) => {
		const current = target.session.model?.provider;
		if (current === undefined || !providerIds.includes(current)) return;
		target.showWarning(
			`models.json no longer defines provider "${current}", the provider of the current model. The running turn finishes; choose another model with /model before the next one.`,
		);
	});
	return () => {
		stopErrors();
		stopRemoved();
	};
}
