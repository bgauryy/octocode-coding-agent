import type { CreateModelsOptions, MutableModels } from "./models/contracts.ts";
import { ModelsImpl } from "./models/models-impl.ts";

export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";
export type {
	CreateModelsOptions,
	Models,
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsDeferredCancelOptions,
	ModelsDeferredFetchOptions,
	ModelsImagesOptions,
	ModelsPublication,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsRequestTransforms,
	ModelsSimpleStreamOptions,
	MutableModels,
	Provider,
	RefreshModelsContext,
} from "./models/contracts.ts";
export { type CreateProviderOptions, createProvider } from "./models/create-provider.ts";
export {
	calculateCost,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	hasApi,
	modelsAreEqual,
} from "./models/model-helpers.ts";
export { AI_TELEMETRY_SCHEMA } from "./telemetry.ts";
export { getModelType, isModelType } from "./utils/model-operations.ts";

export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}
