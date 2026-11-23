import type { Model as ModelsDevSdkModel } from "@opencode-ai/models";
import type { ModelCost, ModelInputLimits } from "../providers/model-schema.ts";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "../utils/thinking-level-rules.ts";

/**
 * The fields Octocode reads from one models.dev listing (https://models.dev, MIT): price with its context tiers, token
 * limits, input and output modalities, tool calling, reasoning options and the lifecycle facts. Pure, so the build-time
 * generator and the runtime catalog map one listing the same way. Provider wiring (api, base URL, compat flags) is not
 * here: it depends on the provider, and the generator and the runtime each own theirs.
 */

/** A models.dev provider listing as the mappers accept it: sparse rows, whose field types the SDK owns. */
export type ModelsDevModel = Pick<ModelsDevSdkModel, "id" | "name"> & Partial<ModelsDevSdkModel>;
export type ModelsDevProvider = { models?: Record<string, ModelsDevModel> };
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export { getEffortThinkingLevelMap, type ModelsDevReasoningOption };

/** Octocode's price (per million tokens) from a models.dev price; a context tier keeps the base rate it does not list. */
export function getModelsDevCost(cost: ModelsDevModel["cost"]): ModelCost {
	const base = {
		input: cost?.input ?? 0,
		output: cost?.output ?? 0,
		cacheRead: cost?.cache_read ?? 0,
		cacheWrite: cost?.cache_write ?? 0,
	};
	const tiers = cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input ?? base.input,
				output: tier.output ?? base.output,
				cacheRead: tier.cache_read ?? base.cacheRead,
				cacheWrite: tier.cache_write ?? base.cacheWrite,
			},
		];
	});
	return tiers && tiers.length > 0 ? { ...base, tiers } : base;
}

/** Token ceilings for a provider listing. Sparse catalogs may report zero or omit either limit. */
export function modelsDevLimits(
	limit: Partial<NonNullable<ModelsDevModel["limit"]>> | undefined,
	fallback = { contextWindow: 4096, maxTokens: 4096 },
): { contextWindow: number; maxTokens: number; inputLimits?: Pick<ModelInputLimits, "maxInputTokens"> } {
	const tokens = (value: number | undefined, missing: number) =>
		value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : missing;
	const contextWindow = tokens(limit?.context, fallback.contextWindow);
	const input = tokens(limit?.input, 0);
	return {
		contextWindow,
		...(input > 0 && input < contextWindow ? { inputLimits: { maxInputTokens: input } } : {}),
		maxTokens: tokens(limit?.output, fallback.maxTokens),
	};
}

/** The input modalities Octocode sends: text, plus images when the listing accepts them. */
export function modelsDevInput(modalities: { input?: readonly string[] } | undefined): ("text" | "image")[] {
	return modalities?.input?.includes("image") ? ["text", "image"] : ["text"];
}

/** Whether the listing says the model calls tools; an agent model needs it. */
export const modelsDevToolCall = (model: Pick<ModelsDevModel, "tool_call">): boolean => model.tool_call === true;

/** Whether the listing says the model reasons. */
export const modelsDevReasoning = (model: Pick<ModelsDevModel, "reasoning">): boolean => model.reasoning === true;

/** A standard chat model: models.dev leaves `type` out for one, or says `chat`. */
export const isModelsDevChat = (model: Pick<ModelsDevModel, "type">): boolean =>
	model.type === undefined || model.type === "chat";

/** Whether the model answers in text: the listing names text among its outputs, or lists no outputs. */
export const modelsDevTextOutput = (model: Pick<ModelsDevModel, "modalities">): boolean =>
	model.modalities?.output === undefined || model.modalities.output.includes("text");

/** One listing's fields as Octocode uses them; optional fields are absent when the listing leaves them out. */
export interface ModelsDevFields {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
	inputLimits?: Pick<ModelInputLimits, "maxInputTokens">;
	toolCall: boolean;
	chat: boolean;
	textOutput: boolean;
	/** How reasoning is set (an effort list, a token budget, a toggle), as models.dev lists it. */
	reasoningOptions?: ModelsDevReasoningOption[];
	/** Model family (`claude-opus`, `gpt-mini`): new releases join an existing family. */
	family?: string;
	/** `deprecated`, `beta` or `alpha`; absent for a current model. */
	status?: string;
	/** `YYYY-MM-DD` or `YYYY-MM`. */
	releaseDate?: string;
	/** When models.dev last changed the listing, `YYYY-MM-DD` or `YYYY-MM`. */
	lastUpdated?: string;
	knowledge?: string;
	description?: string;
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value : undefined;

/** `{ [key]: value }`, or nothing when the value is missing, so an absent field stays absent. */
function present<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

/** Map one models.dev listing, keyed `id` in its provider's `models`, to the fields Octocode uses. */
export function modelsDevFields(id: string, model: ModelsDevModel): ModelsDevFields {
	const options = model.reasoning_options?.filter((option) => typeof option?.type === "string");
	return {
		id,
		name: text(model.name) ?? id,
		reasoning: modelsDevReasoning(model),
		input: modelsDevInput(model.modalities),
		cost: getModelsDevCost(model.cost),
		...modelsDevLimits(model.limit),
		toolCall: modelsDevToolCall(model),
		chat: isModelsDevChat(model),
		textOutput: modelsDevTextOutput(model),
		...present("reasoningOptions", options && options.length > 0 ? options : undefined),
		...present("family", text(model.family)),
		...present("status", text(model.status)),
		...present("releaseDate", text(model.release_date)),
		...present("lastUpdated", text(model.last_updated)),
		...present("knowledge", text(model.knowledge)),
		...present("description", text(model.description)),
	};
}
