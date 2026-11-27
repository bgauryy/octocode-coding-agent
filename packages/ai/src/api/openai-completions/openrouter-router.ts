import type { Model } from "../../types.ts";
import type { JsonObject } from "../../types/json.ts";
import { isOpenRouterModel } from "../../utils/provider-profile.ts";
import type { AssistantMessageDiagnostic } from "../../utils/diagnostics.ts";

/** OpenRouter's Auto Router and its variants (`openrouter/auto`, `openrouter/auto-beta`). */
function isAutoRouterModel(model: Pick<Model<"openai-completions">, "id" | "provider" | "baseUrl">): boolean {
	return isOpenRouterModel(model) && /^openrouter\/auto(?:$|[-/])/.test(model.id);
}

/**
 * The variant's entry in the request's `plugins`, or undefined for a non-Auto Router or no controls. Auto Beta reads
 * only `auto-beta-router`; Auto and Auto Code read `auto-router`. A fresh object prevents cross-request mutation.
 */
export function autoRouterPlugin(model: Model<"openai-completions">): JsonObject | undefined {
	const controls = model.compat?.openRouterAutoRouter;
	if (!controls || !isAutoRouterModel(model)) return undefined;
	const plugin: JsonObject = { id: model.id === "openrouter/auto-beta" ? "auto-beta-router" : "auto-router" };
	if (controls.allowed_models?.length) plugin.allowed_models = [...controls.allowed_models];
	if (controls.excluded_models?.length) plugin.excluded_models = [...controls.excluded_models];
	if (controls.cost_tier) plugin.cost_tier = controls.cost_tier;
	return Object.keys(plugin).length > 1 ? plugin : undefined;
}

/** Whether to ask for `openrouter_metadata`: on for the Auto Router unless its controls turn it off. */
export function wantsRouterMetadata(model: Model<"openai-completions">): boolean {
	return isAutoRouterModel(model) && model.compat?.openRouterAutoRouter?.metadata !== false;
}

const MAX_TEXT = 200;
const MAX_ITEMS = 16;

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value ? value.slice(0, MAX_TEXT) : undefined;
const integer = (value: unknown): number | undefined => (Number.isInteger(value) ? (value as number) : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Drops undefined fields; every value left came through `text`, `integer` or a boolean check, so it is JSON. */
function defined(entries: Record<string, unknown>): JsonObject {
	return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as JsonObject;
}

function items(
	value: unknown,
	pick: (item: Record<string, unknown>) => Record<string, unknown>,
): JsonObject[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const picked: JsonObject[] = [];
	for (const item of value.slice(0, MAX_ITEMS)) {
		const fields = record(item);
		if (fields) picked.push(defined(pick(fields)));
	}
	return picked;
}

/**
 * A diagnostic from `openrouter_metadata`: the routing decision (requested model, strategy, attempts, selected endpoint,
 * stage names). Only allow-listed scalar fields are copied, with bounded lengths; a stage's free-form `data`,
 * the summary text and any prompt-derived value are dropped.
 */
export function routerMetadataDiagnostic(metadata: unknown): AssistantMessageDiagnostic | undefined {
	const raw = record(metadata);
	if (!raw) return undefined;
	const endpoints = record(raw.endpoints);
	const selected = items(endpoints?.available, (e) => ({
		provider: text(e.provider),
		model: text(e.model),
		selected: typeof e.selected === "boolean" ? e.selected : undefined,
	}))?.filter((endpoint) => endpoint.selected === true);
	const details = defined({
		requested: text(raw.requested),
		strategy: text(raw.strategy),
		region: text(raw.region),
		attempt: integer(raw.attempt),
		isByok: typeof raw.is_byok === "boolean" ? raw.is_byok : undefined,
		endpointsTotal: integer(endpoints?.total),
		selected,
		attempts: items(raw.attempts, (a) => ({
			provider: text(a.provider),
			model: text(a.model),
			status: integer(a.status),
		})),
		pipeline: items(raw.pipeline, (s) => ({ type: text(s.type), name: text(s.name) })),
	});
	return Object.keys(details).length ? { type: "openrouter-router", timestamp: Date.now(), details } : undefined;
}
