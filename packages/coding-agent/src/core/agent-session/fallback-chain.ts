/**
 * Which ordered list of fallback models a failing model continues on: its `retry.fallbackChains` entry, else the chain
 * it is a member of (a fallback that fails in turn keeps walking its own chain), else `retry.fallbackModels`.
 */

import { minimatch } from "minimatch";
import { tryParseModelReference } from "../model-reference.ts";
import type { SettingsManager } from "../settings-manager.ts";

const sameModel = (selector: string, provider: string, id: string): boolean => {
	const reference = tryParseModelReference(selector.trim());
	return reference?.provider === provider && reference.id === id;
};

/** The selectors to try, in order, after `provider/id` failed. */
export function fallbackSelectors(
	settings: Pick<SettingsManager, "getRetryFallbackChains" | "getRetryFallbackModels">,
	provider: string,
	id: string,
): string[] {
	const chains = Object.entries(settings.getRetryFallbackChains());
	const key = `${provider}/${id}`;
	const keyed = chains.find(([name]) => name.trim() === key);
	if (keyed) return keyed[1];
	const matched = chains.find(([name]) => {
		const reference = tryParseModelReference(name.trim());
		return reference?.glob === true && minimatch(key, name.trim(), { nocase: true });
	});
	if (matched) return matched[1];
	const member = chains.find(([, list]) => list.some((selector) => sameModel(selector, provider, id)));
	if (member) return member[1];
	return settings.getRetryFallbackModels();
}
