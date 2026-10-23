import { type Model, modelsAreEqual } from "@octocodeai/octocode-ai";

export interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

export interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

export interface DefaultModelReference {
	provider: string;
	id: string;
}

export type ModelScope = "all" | "scoped";

export function isDefaultModel(defaultModel: DefaultModelReference | undefined, model: Model<any>): boolean {
	return defaultModel?.provider === model.provider && defaultModel.id === model.id;
}

export function isDefaultSearch(query: string): boolean {
	const normalized = query.trim().toLowerCase();
	return normalized.length > 0 && "default".startsWith(normalized);
}

export function sortModelItems(
	models: ModelItem[],
	currentModel: Model<any> | undefined,
	defaultModel: DefaultModelReference | undefined,
): ModelItem[] {
	const sorted = [...models];
	// Sort: current model first, default model second, then by provider.
	sorted.sort((a, b) => {
		const aIsCurrent = modelsAreEqual(currentModel, a.model);
		const bIsCurrent = modelsAreEqual(currentModel, b.model);
		if (aIsCurrent && !bIsCurrent) return -1;
		if (!aIsCurrent && bIsCurrent) return 1;
		const aIsDefault = isDefaultModel(defaultModel, a.model);
		const bIsDefault = isDefaultModel(defaultModel, b.model);
		if (aIsDefault && !bIsDefault) return -1;
		if (!aIsDefault && bIsDefault) return 1;
		return a.provider.localeCompare(b.provider);
	});
	return sorted;
}
