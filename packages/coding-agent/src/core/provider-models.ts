/**
 * Which of a provider's models the user hides. One module for the terminal `/providers` page, the web provider page
 * and the model runtime: the global `hiddenModels` setting maps a provider id to the model ids it hides. A provider
 * with no entry shows every model, and a model the provider adds later shows until it is unticked.
 */

/** Provider id to the model ids hidden from `/model`, Ctrl+P and subagent routing. */
export type HiddenModels = Readonly<Record<string, readonly string[]>>;

/** What the saves need of the settings manager; structural, so this module imports nothing and stays a leaf. */
interface Hiding {
	getHiddenModels(): Record<string, string[]>;
	setHiddenModels(hidden: HiddenModels): void;
}

/** The map without empty entries, duplicate ids or anything that is not a string list; a malformed value reads as none. */
export function normalizeHiddenModels(value: unknown): Record<string, string[]> {
	const result: Record<string, string[]> = Object.create(null);
	if (typeof value !== "object" || value === null || Array.isArray(value)) return result;
	for (const [provider, ids] of Object.entries(value)) {
		if (!Array.isArray(ids)) continue;
		const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))];
		if (unique.length > 0) result[provider] = unique;
	}
	return result;
}

export function isModelHidden(hidden: HiddenModels, provider: string, id: string): boolean {
	return Object.hasOwn(hidden, provider) && hidden[provider].includes(id);
}

/** The models the user left ticked: everything not hidden. */
export function visibleModels<T extends { provider: string; id: string }>(
	models: readonly T[],
	hidden: HiddenModels,
): T[] {
	return models.filter((model) => !isModelHidden(hidden, model.provider, model.id));
}

/** The ids of `provider` that its page shows ticked, in `ids` order. */
export function tickedModelIds(hidden: HiddenModels, provider: string, ids: readonly string[]): string[] {
	return ids.filter((id) => !isModelHidden(hidden, provider, id));
}

/**
 * Save which of `provider`'s models are hidden. An empty list removes the provider's entry, so it shows everything
 * again. Ids the provider no longer lists stay hidden: a catalog that comes back keeps the user's choice.
 */
export function setProviderHiddenModels(settings: Hiding, provider: string, hidden: readonly string[]): void {
	const next = normalizeHiddenModels({ ...settings.getHiddenModels(), [provider]: hidden });
	settings.setHiddenModels(next);
}

/** The terminal page's form of the same save: `ticked` of the provider's `ids` stay visible, the rest are hidden. */
export function setProviderTickedModels(
	settings: Hiding,
	provider: string,
	ids: readonly string[],
	ticked: readonly string[],
): void {
	const keep = new Set(ticked);
	const current = settings.getHiddenModels()[provider] ?? [];
	// Hidden ids this page did not list (a catalog that is not loaded now) stay hidden.
	const unlisted = current.filter((id) => !ids.includes(id));
	setProviderHiddenModels(settings, provider, [...unlisted, ...ids.filter((id) => !keep.has(id))]);
}

/** Give the runtime the settings' provider switches and model choices, so every consumer of availability follows. */
export function applyProviderVisibility(
	runtime: { setDisabledProviders(ids: readonly string[]): void; setHiddenModels(hidden: HiddenModels): void },
	settings: { getDisabledProviders(): string[]; getHiddenModels(): Record<string, string[]> },
): void {
	runtime.setHiddenModels(settings.getHiddenModels());
	runtime.setDisabledProviders(settings.getDisabledProviders());
}
