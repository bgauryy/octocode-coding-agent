/**
 * List available models with optional fuzzy search
 */

import type { Api, Model } from "@octocodeai/octocode-ai";
import { modelSizeClass, SIZE_RANK, type SizeClass } from "../octocode/subagents/size-class.ts";
import { bedrockModelAccess } from "../core/bedrock-model-access.ts";
import { fuzzyFilter } from "@octocodeai/octocode-tui";
import { cliStyle } from "../utils/cli-style.ts";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { formatTokens } from "../octocode/shared/format.ts";

/**
 * List available models, optionally filtered by search pattern
 */
export async function listModels(
	modelRuntime: ModelRuntime,
	searchPattern?: string,
	signal?: AbortSignal,
	options: { provider?: string; size?: SizeClass; checkAccess?: boolean } = {},
): Promise<void> {
	const loadError = modelRuntime.getError();
	if (loadError) {
		console.error(cliStyle.warn(`Warning: errors loading models.json:\n${loadError}`));
	}

	const models = [...(await modelRuntime.getAvailable(undefined, { signal }))];

	if (models.length === 0) {
		console.log(formatNoModelsAvailableMessage("cli"));
		return;
	}

	let filteredModels: Model<Api>[] = models.filter(
		(m) =>
			(!options.provider || m.provider === options.provider) && (!options.size || modelSizeClass(m) === options.size),
	);
	if (searchPattern) {
		filteredModels = fuzzyFilter(filteredModels, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	if (filteredModels.length === 0) {
		console.log(`No models match ${[options.provider, options.size, searchPattern].filter(Boolean).join(" ")}`);
		return;
	}

	filteredModels.sort((a, b) => {
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return (
			SIZE_RANK[modelSizeClass(a)] - SIZE_RANK[modelSizeClass(b)] ||
			b.contextWindow - a.contextWindow ||
			a.id.localeCompare(b.id)
		);
	});

	const access = options.checkAccess ? await bedrockModelAccess(modelRuntime, filteredModels, signal) : undefined;
	const rows = filteredModels.map((m) => ({
		provider: m.provider,
		model: m.id,
		size: modelSizeClass(m),
		access: access?.get(m) ?? "unverified",
		context: formatTokens(m.contextWindow),
		maxOut: formatTokens(m.maxTokens),
		thinking: m.reasoning ? "yes" : "no",
		images: m.input.includes("image") ? "yes" : "no",
	}));

	const headers = {
		provider: "provider",
		model: "model",
		size: "size (est.)",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	};

	const widths = {
		provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
		size: Math.max(headers.size.length, ...rows.map((r) => r.size.length)),
		model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
		images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
	};

	const headerLine = [
		headers.provider.padEnd(widths.provider),
		headers.model.padEnd(widths.model),
		headers.size.padEnd(widths.size),
		headers.context.padEnd(widths.context),
		headers.maxOut.padEnd(widths.maxOut),
		headers.thinking.padEnd(widths.thinking),
		headers.images.padEnd(widths.images),
		...(access ? ["account access"] : []),
	].join("  ");
	console.log(headerLine);

	for (const row of rows) {
		const line = [
			row.provider.padEnd(widths.provider),
			row.model.padEnd(widths.model),
			row.size.padEnd(widths.size),
			row.context.padEnd(widths.context),
			row.maxOut.padEnd(widths.maxOut),
			row.thinking.padEnd(widths.thinking),
			row.images.padEnd(widths.images),
			...(access ? [row.access] : []),
		].join("  ");
		console.log(line);
	}
}
