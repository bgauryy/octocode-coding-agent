/**
 * Resolves a model's provider profile and its facts. A declared `profile` (models.json, carried on `Model.profile`)
 * wins; otherwise the table's own match rules decide, from the provider id or the host, so a model without a profile
 * behaves as it always did.
 */

import type { Api, Model, ProviderProfileId } from "../types.ts";
import { matchesDomain, matchesHost } from "./provider-host.ts";
import {
	PROVIDER_PROFILES,
	type ProfileCacheFacts,
	type ProfileMatch,
	type ProfileQuirks,
} from "./provider-profile-data.ts";

export type ProfiledModel = Pick<Model<Api>, "provider"> & {
	baseUrl?: string;
	api?: Api;
	profile?: ProviderProfileId;
};

/**
 * Which facts to resolve for. `any`: the provider id or the host selects the profile. `host`: for facts that hold only
 * on the provider's own endpoint (Anthropic's long tier, OpenAI's cache key), a provider id on another host does not.
 */
export type ProfileScope = "any" | "host";

function matchesProvider(match: ProfileMatch, provider: string): boolean {
	return (
		(match.providers?.includes(provider) ?? false) ||
		(match.providerPrefixes?.some((prefix) => provider.startsWith(prefix)) ?? false)
	);
}

function matchesEndpoint(match: ProfileMatch, baseUrl: string | undefined): boolean {
	if (baseUrl === undefined) return false;
	return (
		(match.hosts?.some((host) => matchesHost(baseUrl, host)) ?? false) ||
		((match.domains?.length ?? 0) > 0 && matchesDomain(baseUrl, ...(match.domains ?? []))) ||
		(match.hostTest?.(baseUrl) ?? false)
	);
}

function detects(match: ProfileMatch, model: ProfiledModel, scope: ProfileScope): boolean {
	if (match.apis && !(model.api && match.apis.includes(model.api))) return false;
	const byProvider = !(scope === "host" && match.hostBound) && matchesProvider(match, model.provider);
	return byProvider || matchesEndpoint(match, model.baseUrl);
}

/** The profile a model declares, else the first table entry its provider id or host fits. */
export function resolveProviderProfile(
	model: ProfiledModel,
	scope: ProfileScope = "any",
): ProviderProfileId | undefined {
	if (model.profile) return model.profile;
	for (const [id, profile] of Object.entries(PROVIDER_PROFILES))
		if (detects(profile.match, model, scope)) return id as ProviderProfileId;
	return undefined;
}

/** Whether the model's profile is `id`. */
export function hasProviderProfile(model: ProfiledModel, id: ProviderProfileId, scope: ProfileScope = "any"): boolean {
	return resolveProviderProfile(model, scope) === id;
}

const NONE: Readonly<Record<string, never>> = Object.freeze({});

/** The cache facts of the model's profile; empty when it has none. */
export function profileCacheFacts(model: ProfiledModel, scope: ProfileScope = "host"): ProfileCacheFacts {
	const id = resolveProviderProfile(model, scope);
	return (id ? PROVIDER_PROFILES[id].cache : undefined) ?? NONE;
}

/** The request-format quirks of the model's profile; empty when it has none. */
export function profileQuirks(model: ProfiledModel, scope: ProfileScope = "any"): ProfileQuirks {
	const id = resolveProviderProfile(model, scope);
	return (id ? PROVIDER_PROFILES[id].quirks : undefined) ?? NONE;
}

/** Whether the facts mark an id as one the profile's markers apply to. */
export function markersApplyTo(facts: ProfileCacheFacts, modelId: string): boolean {
	if (!facts.markers) return false;
	return facts.markers === "all" || facts.markers.modelPrefixes.some((prefix) => modelId.startsWith(prefix));
}

/** OpenRouter itself, by declared profile, provider id or API host. The one definition every adapter and host attribution shares. */
export function isOpenRouterModel(model: ProfiledModel): boolean {
	return hasProviderProfile(model, "openrouter");
}
