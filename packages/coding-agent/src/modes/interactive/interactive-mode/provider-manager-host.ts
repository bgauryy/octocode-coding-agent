import type { InteractiveModeHost } from "./host.ts";

/** The interactive-mode members the provider manager and the Pi provider list call. */
export type ProviderManagerHost = Pick<
	InteractiveModeHost,
	| "session"
	| "getLoginProviderOptions"
	| "showSelector"
	| "showSelectorDialog"
	| "showInputDialog"
	| "showLoginDialog"
	| "showApiKeyLoginDialog"
	| "showAmbientAuthDialog"
	| "showModelSelector"
	| "showStatus"
	| "showError"
	| "showWarning"
	| "updateAvailableProviderCount"
	| "ui"
>;
