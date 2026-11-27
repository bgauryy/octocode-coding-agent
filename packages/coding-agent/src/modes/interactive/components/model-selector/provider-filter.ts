import { theme } from "../../../../theme/theme.ts";
import type { ModelItem } from "./model-items.ts";

/** The providers of `items`, each once, in list order: the stops the model selector's provider filter cycles through. */
export function providersOf(items: readonly ModelItem[]): string[] {
	return [...new Set(items.map((item) => item.provider))];
}

/**
 * The provider one `step` away from `current` in the cycle "all providers, then each provider": `undefined` stands for
 * all. A `current` no longer among `providers` counts as all.
 */
export function stepProvider(
	providers: readonly string[],
	current: string | undefined,
	step: 1 | -1,
): string | undefined {
	const stops: (string | undefined)[] = [undefined, ...providers];
	const index = Math.max(0, stops.indexOf(current));
	return stops[(index + step + stops.length) % stops.length];
}

/** The models of `items` from provider `filter`, or all of them, with the filter dropped once its provider is gone. */
export function filterByProvider(
	items: ModelItem[],
	filter: string | undefined,
): { filter: string | undefined; items: ModelItem[] } {
	const kept = filter === undefined ? [] : items.filter((item) => item.provider === filter);
	return kept.length > 0 ? { filter, items: kept } : { filter: undefined, items };
}

/** The selector's provider line: which provider is shown and the keys that switch it. */
export function providerLine(filter: string | undefined): string {
	return `${theme.fg("muted", "Provider: ")}${theme.fg("accent", filter ?? "all")}${theme.fg("muted", "  ←/→ switch")}`;
}
