/**
 * List available models with optional fuzzy search
 */

import type { Api, Model } from "@octocodeai/octocode-ai";
import { modelSizeClass, SIZE_RANK, type SizeClass } from "../octocode/subagents/size-class.ts";
import { bedrockModelAccess } from "../core/bedrock-model-access.ts";
import { fuzzyFilter } from "@octocodeai/octocode-tui";
import { cliStyle } from "../utils/cli-style.ts";
import { formatNoApiKeyFoundMessage, formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import { APP_NAME } from "../config.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { formatTokens } from "../octocode/shared/format.ts";

/** Why `--provider <id>` lists nothing: no such provider, or one with no usable credentials; undefined when it has models. */
function unusableProvider(
	runtime: Pick<ModelRuntime, "getProviders" | "getDefinedProviderIds">,
	available: readonly Model<Api>[],
	provider: string,
): string | undefined {
	if (available.some((model) => model.provider === provider)) return undefined;
	const connected = [...new Set(available.map((model) => model.provider))].sort();
	const known =
		runtime.getProviders().some((entry) => entry.id === provider) || runtime.getDefinedProviderIds().includes(provider);
	if (known) return formatNoApiKeyFoundMessage(provider, "cli");
	return `Unknown provider "${provider}". Connected: ${connected.join(", ")}. ${APP_NAME} --list-models lists their models.`;
}

/** What an empty filtered list says: the filters that matched nothing, and the command that lists the rest. */
function noMatchText(provider: string | undefined, size: SizeClass | undefined, search: string | undefined): string {
	const filters = [
		...(provider ? [`provider ${provider}`] : []),
		...(size ? [`size ${size}`] : []),
		...(search ? [`search "${search}"`] : []),
	];
	const wider = provider ? `${APP_NAME} --list-models --provider ${provider}` : `${APP_NAME} --list-models`;
	return `No models match ${filters.join(", ")}. ${wider} lists every one you can use.`;
}

/** The note under a `--check-model-access` table: what `unverified` and `not Bedrock` mean. */
function accessNote(rows: readonly { access: string }[]): string[] {
	const notes: string[] = [];
	if (rows.some((row) => row.access.startsWith("unverified")))
		notes.push(
			"unverified: AWS did not confirm access (the reason is in parentheses); a request may still work or fail.",
		);
	if (rows.some((row) => row.access === NOT_CHECKED))
		notes.push(`${NOT_CHECKED}: only Amazon Bedrock access can be checked without a request.`);
	return notes;
}

/** The access cell of a model `--check-model-access` cannot check: only Bedrock answers without a request. */
const NOT_CHECKED = "not Bedrock";

/**
 * List available models, optionally filtered by search pattern. Resolves to the exit status: 1 when `--provider` names
 * a provider that is unknown or has no usable credentials (told on stderr), else 0.
 */
export async function listModels(
	modelRuntime: ModelRuntime,
	searchPattern?: string,
	signal?: AbortSignal,
	options: { provider?: string; size?: SizeClass; checkAccess?: boolean } = {},
): Promise<number> {
	const loadError = modelRuntime.getError();
	if (loadError) {
		console.error(cliStyle.warn(`Warning: errors loading models.json:\n${loadError}`));
	}

	const models = [...(await modelRuntime.getAvailable(undefined, { signal }))];

	if (models.length === 0) {
		console.log(formatNoModelsAvailableMessage("cli"));
		return 0;
	}

	const providerProblem = options.provider ? unusableProvider(modelRuntime, models, options.provider) : undefined;
	if (providerProblem) {
		console.error(providerProblem);
		return 1;
	}

	let filteredModels: Model<Api>[] = models.filter(
		(m) =>
			(!options.provider || m.provider === options.provider) && (!options.size || modelSizeClass(m) === options.size),
	);
	if (searchPattern) {
		filteredModels = fuzzyFilter(filteredModels, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	if (filteredModels.length === 0) {
		console.log(noMatchText(options.provider, options.size, searchPattern));
		return 0;
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
		access: access?.get(m) ?? NOT_CHECKED,
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
	if (access) for (const note of accessNote(rows)) console.log(cliStyle.dim(note));
	return 0;
}
