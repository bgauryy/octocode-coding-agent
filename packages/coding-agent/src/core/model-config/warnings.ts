/** Load-time warnings for a models.json that passed its schema: fields it ignores and `api` values no built-in serves. */

import type { KnownApi } from "@octocodeai/octocode-ai";
import { closestIds } from "../../configuration/result.ts";

/** Every built-in API; typed over `KnownApi` so a new one must be listed here. */
const BUILTIN_APIS: Record<KnownApi, true> = {
	"openai-completions": true,
	"mistral-conversations": true,
	"openai-responses": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
	"anthropic-messages": true,
	"bedrock-converse-stream": true,
	"google-generative-ai": true,
	"google-vertex": true,
};
const BUILTIN_API_NAMES = Object.keys(BUILTIN_APIS);

/** The field names each entry kind accepts, taken from the models.json schema. */
export interface ModelsJsonFieldNames {
	root: readonly string[];
	provider: readonly string[];
	model: readonly string[];
	modelOverride: readonly string[];
}

type Entry = Record<string, unknown>;
const isEntry = (value: unknown): value is Entry =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function suggestion(name: string, candidates: readonly string[]): string {
	const [closest] = closestIds(name, candidates, 1);
	return closest ? ` Did you mean "${closest}"?` : "";
}

/** Warnings naming `path` and the provider; the file still loads. */
export function modelsJsonWarnings(parsed: Entry, path: string, fields: ModelsJsonFieldNames): string[] {
	const found: string[] = [];
	const unknownFields = (entry: Entry, accepted: readonly string[], at: string) => {
		for (const name of Object.keys(entry)) {
			if (accepted.includes(name)) continue;
			found.push(`${at}.${name} is not a models.json field and is ignored.${suggestion(name, accepted)}`);
		}
	};
	const unknownApi = (entry: Entry, at: string) => {
		if (typeof entry.api !== "string" || Object.hasOwn(BUILTIN_APIS, entry.api)) return;
		found.push(
			`${at}.api "${entry.api}" is not a built-in API; requests fail unless an extension provides it.${suggestion(entry.api, BUILTIN_API_NAMES)}`,
		);
	};
	unknownFields(parsed, fields.root, "(top level)");
	const providers = isEntry(parsed.providers) ? parsed.providers : {};
	for (const [providerId, provider] of Object.entries(providers)) {
		if (!isEntry(provider)) continue;
		const at = `providers.${providerId}`;
		unknownFields(provider, fields.provider, at);
		unknownApi(provider, at);
		const models = Array.isArray(provider.models) ? provider.models : [];
		for (const [index, model] of models.entries()) {
			if (!isEntry(model)) continue;
			const modelAt = `${at}.models[${typeof model.id === "string" ? model.id : index}]`;
			unknownFields(model, fields.model, modelAt);
			unknownApi(model, modelAt);
		}
		const overrides = isEntry(provider.modelOverrides) ? provider.modelOverrides : {};
		for (const [modelId, override] of Object.entries(overrides)) {
			if (isEntry(override)) unknownFields(override, fields.modelOverride, `${at}.modelOverrides.${modelId}`);
		}
	}
	return found.map((warning) => `${path}: ${warning}`);
}
