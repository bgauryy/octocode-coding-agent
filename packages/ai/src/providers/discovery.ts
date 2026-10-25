import type { ModelAuth } from "../auth/types.ts";
import type { Models, Provider } from "../models.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { MODEL_DISCOVERY_SOURCES, type ModelDiscoverySource } from "./discovery-sources.ts";

export { MODEL_DISCOVERY_SOURCES } from "./discovery-sources.ts";

export interface DiscoveredVendorModel {
	id: string;
	name?: string;
	inputTokenLimit?: number;
	outputTokenLimit?: number;
}

export interface ProviderModelDiscovery {
	provider: string;
	status: "verified" | "catalog" | "unsupported" | "unconfigured" | "error";
	docs?: string;
	note?: string;
	models: (DiscoveredVendorModel & { known: boolean })[];
	missingFromVendor?: string[];
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid vendor model-list response");
	return value as Record<string, unknown>;
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** List only; this never invents prices, inference capabilities, or runtime model definitions. */
export async function requestVendorModels(
	provider: Pick<Provider, "id" | "baseUrl" | "getModels" | "headers">,
	auth: ModelAuth,
	options: { signal?: AbortSignal; fetch?: typeof fetch; chatGPT?: boolean; baseUrl?: string } = {},
): Promise<DiscoveredVendorModel[]> {
	const source = MODEL_DISCOVERY_SOURCES[provider.id];
	if (!source?.path) throw new Error("No documented HTTP model discovery route for this provider");
	let base = options.baseUrl ?? auth.baseUrl ?? provider.baseUrl ?? provider.getModels()[0]?.baseUrl;
	// OpenCode's provider root is family-dependent; its public catalog has its own route.
	if (provider.id === "opencode" && !provider.baseUrl && !options.baseUrl && !auth.baseUrl)
		base = "https://opencode.ai/inference";
	if (!base) throw new Error("Model discovery requires a configured API base URL");
	const url = new URL(source.path, `${base.replace(/\/+$/, "")}/`);
	const headers = discoveryHeaders(source, auth, provider.headers);
	const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]);
	const found = new Map<string, DiscoveredVendorModel>();
	const cursors = new Set<string>();
	for (let page = 0; page < 100; page++) {
		signal.throwIfAborted();
		const response = await (options.fetch ?? fetch)(url, { headers, signal, redirect: "error" });
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`Vendor model discovery failed (HTTP ${response.status})`);
		}
		const text = await response.text();
		if (text.length > 4_000_000) throw new Error("Vendor model list exceeds the response size limit");
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new Error("Vendor model list is not valid JSON");
		}
		const record = Array.isArray(body) ? { data: body } : object(body);
		const rows = options.chatGPT || source.format === "google" ? record.models : record.data;
		if (!Array.isArray(rows)) throw new Error("Vendor model list has no model array");
		for (const raw of rows) {
			const entry = object(raw);
			if (options.chatGPT && entry.visibility !== "list") continue;
			const rawId = options.chatGPT ? entry.slug : source.format === "google" ? entry.name : entry.id;
			if (typeof rawId !== "string" || !rawId.trim()) throw new Error("Vendor model list contains an invalid model ID");
			const id = source.format === "google" ? rawId.replace(/^models\//, "") : rawId;
			const name = entry.display_name ?? entry.displayName ?? entry.name;
			found.set(id, {
				id,
				...(typeof name === "string" ? { name } : {}),
				...(positive(entry.inputTokenLimit) ? { inputTokenLimit: positive(entry.inputTokenLimit) } : {}),
				...(positive(entry.outputTokenLimit) ? { outputTokenLimit: positive(entry.outputTokenLimit) } : {}),
			});
		}
		const cursor =
			source.format === "google"
				? record.nextPageToken
				: source.format === "anthropic" && record.has_more
					? record.last_id
					: undefined;
		if (source.format === "anthropic" && record.has_more === true && (typeof cursor !== "string" || !cursor))
			throw new Error("Vendor model list is missing its pagination cursor");
		if (cursor === undefined || cursor === null || cursor === "") return [...found.values()];
		if (typeof cursor !== "string" || cursors.has(cursor))
			throw new Error("Invalid or repeated vendor pagination cursor");
		cursors.add(cursor);
		url.searchParams.set(source.format === "google" ? "pageToken" : "after_id", cursor);
	}
	throw new Error("Vendor model list exceeded the page limit");
}

function discoveryHeaders(
	source: ModelDiscoverySource,
	auth: ModelAuth,
	headers: Provider["headers"],
): Record<string, string> {
	const defaults: Record<string, string> = { accept: "application/json" };
	if (auth.apiKey) {
		if (source.format === "anthropic") defaults["x-api-key"] = auth.apiKey;
		else if (source.format === "google") defaults["x-goog-api-key"] = auth.apiKey;
		else defaults.Authorization = `Bearer ${auth.apiKey}`;
	}
	if (source.format === "anthropic") defaults["anthropic-version"] = "2023-06-01";
	return providerHeadersToRecord(defaults, headers, auth.headers) ?? defaults;
}

export async function discoverProviderModels(
	models: Pick<Models, "getProvider" | "getAuth" | "getAllModels">,
	providerId: string,
	options: { allowNetwork?: boolean; signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<ProviderModelDiscovery> {
	const provider = models.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const source = MODEL_DISCOVERY_SOURCES[providerId];
	const catalog = models.getAllModels(providerId);
	const known = new Set(catalog.map((model) => model.id));
	const result: ProviderModelDiscovery = {
		provider: providerId,
		status: "catalog",
		docs: source?.docs,
		note: source?.note,
		models: [...new Map(catalog.map((model) => [model.id, { id: model.id, name: model.name, known: true }])).values()],
	};
	if (options.allowNetwork === false) return result;
	if (!source?.path) return { ...result, status: "unsupported" };
	try {
		const resolved = source.public
			? { auth: {}, source: "public catalog" }
			: await models.getAuth(providerId, { signal: options.signal });
		if (!resolved) return { ...result, status: "unconfigured" };
		const listed = await requestVendorModels(provider, resolved.auth, {
			...options,
			chatGPT: providerId === "openai" && resolved.source === "OAuth",
		});
		const ids = new Set(listed.map((model) => model.id));
		return {
			...result,
			status: "verified",
			models: listed.map((model) => ({ ...model, known: known.has(model.id) })),
			missingFromVendor: [...known].filter((id) => !ids.has(id)),
		};
	} catch (error) {
		options.signal?.throwIfAborted();
		return { ...result, status: "error", note: error instanceof Error ? error.message : "Vendor discovery failed" };
	}
}
