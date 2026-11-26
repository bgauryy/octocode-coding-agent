/**
 * Field-by-field merge of one provider's definitions across models.json scopes. A narrower scope overrides the fields
 * it names and keeps the rest of the wider one; a project file may add models and tune defaults, but may not change how
 * a provider the wider scopes define is reached (its host, API, headers, key, key command or key variables), so a project cannot send a stored key
 * to a host of its own choosing.
 */

import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { deepFreeze } from "./provider-checks.ts";

type Entry = Record<string, unknown>;

/** The parts of a models.json provider this merge reads; the caller's full provider type passes through unchanged. */
type ProviderEntry = { models?: readonly Entry[]; modelOverrides?: Readonly<Record<string, Entry>> };

/** One file's definition of a provider. */
export interface ScopedDefinition<P extends ProviderEntry = ProviderEntry> {
	file: string;
	provider: P;
	/** Whether the file belongs to the (trusted) project. */
	project: boolean;
}

/** The fields that decide where a provider's requests, and the key they carry, go. */
const REACH_FIELDS = ["baseUrl", "api", "headers", "apiKey", "auth", "env"] as const;

/** Plain objects merge recursively, the narrower value winning; arrays and scalars are replaced. */
function mergeValue(wider: unknown, narrower: unknown): unknown {
	if (narrower === undefined) return wider;
	if (!isRecord(wider) || !isRecord(narrower)) return narrower;
	const merged: Entry = { ...wider };
	for (const [key, value] of Object.entries(narrower)) merged[key] = mergeValue(wider[key], value);
	return merged;
}

/** Model entries are matched by id: a narrower entry tunes the wider one, a new id is appended. */
function mergeModels(wider: readonly Entry[] | undefined, narrower: readonly Entry[] | undefined): Entry[] | undefined {
	if (!wider || !narrower) return (narrower ?? wider) as Entry[] | undefined;
	const merged = [...wider];
	for (const model of narrower) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index < 0) merged.push(model);
		else merged[index] = mergeValue(merged[index], model) as Entry;
	}
	return merged;
}

function mergeProviders<P extends ProviderEntry>(wider: P, narrower: P): P {
	const merged = mergeValue({ ...wider, models: undefined }, { ...narrower, models: undefined }) as Entry;
	const models = mergeModels(wider.models, narrower.models);
	if (models) merged.models = models;
	else delete merged.models;
	return merged as P;
}

/** The provider without the fields that decide where requests go, and the names of the fields dropped. */
function withoutReachFields<P extends ProviderEntry>(provider: P): { provider: P; dropped: string[] } {
	const dropped: string[] = [];
	const entry: Entry = { ...provider };
	for (const field of REACH_FIELDS) {
		if (entry[field] === undefined) continue;
		delete entry[field];
		dropped.push(field);
	}
	if (provider.models) {
		entry.models = provider.models.map((model) => {
			const stripped: Entry = { ...model };
			for (const field of ["baseUrl", "api", "headers"]) {
				if (stripped[field] === undefined) continue;
				delete stripped[field];
				dropped.push(`models[${String(model.id)}].${field}`);
			}
			return stripped;
		});
	}
	if (provider.modelOverrides) {
		const overrides: Entry = {};
		for (const [modelId, override] of Object.entries(provider.modelOverrides)) {
			const { headers, ...rest } = override;
			if (headers !== undefined) dropped.push(`modelOverrides.${modelId}.headers`);
			overrides[modelId] = rest;
		}
		entry.modelOverrides = overrides;
	}
	return { provider: entry as P, dropped };
}

/**
 * One provider from its definitions, narrowest first (the order discovery ranks the files). A project definition loses
 * its reach fields when a non-project file defines the provider too; a warning names each dropped field.
 */
export function mergeProviderScopes<P extends ProviderEntry>(
	providerId: string,
	definitions: readonly ScopedDefinition<P>[],
): { provider: P; warnings: string[] } {
	const warnings: string[] = [];
	if (definitions.length === 1) return { provider: definitions[0].provider, warnings };
	const widerScopeDefines = definitions.some((definition) => !definition.project);
	let merged: P | undefined;
	for (const { file, provider, project } of [...definitions].reverse()) {
		let layer = provider;
		if (project && widerScopeDefines) {
			const { provider: allowed, dropped } = withoutReachFields(provider);
			layer = allowed;
			if (dropped.length > 0) {
				warnings.push(
					`Project models.json ${file} sets ${dropped.join(", ")} on provider "${providerId}", which a global models.json also defines: ignored. A project may add models and tune defaults, but not change where a provider's requests and key go; set those in the global file.`,
				);
			}
		}
		merged = merged ? mergeProviders(merged, layer) : layer;
	}
	return { provider: deepFreeze(structuredClone(merged as P)), warnings };
}
