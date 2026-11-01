import type { ModelAuth } from "../auth/types.ts";
import type { Models, Provider } from "../models.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { hasControlCharacters, modelLabel } from "../utils/model-text.ts";
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
			// An id is a key sent back to the vendor: one holding a terminal control is rejected, never rewritten.
			if (typeof rawId !== "string" || !rawId.trim() || hasControlCharacters(rawId))
				throw new Error("Vendor model list contains an invalid model ID");
			const id = source.format === "google" ? rawId.replace(/^models\//, "") : rawId;
			const rawName = entry.display_name ?? entry.displayName ?? entry.name;
			const name = typeof rawName === "string" ? modelLabel(rawName) : "";
			found.set(id, {
				id,
				...(name ? { name } : {}),
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

/** Whether a credential resolved from `credentialSource` is a ChatGPT login, whose OpenAI model list is another route. */
function isChatGPTLogin(providerId: string, credentialSource: string | undefined): boolean {
	return providerId === "openai" && credentialSource === "OAuth";
}

/** A credential check answered by the provider's model list. */
export type ListCredentialCheck = { ok: true; models: DiscoveredVendorModel[] } | { ok: false; detail: string };

/**
 * Check a credential with the provider's model list instead of an inference request: free, and the list comes back
 * with it. Undefined when the provider has no list route, or only a public one (a public list proves no credential).
 * Failures carry the HTTP status, never the response body. `credentialSource` is the source the auth resolved from
 * (`ModelRegistry.getProviderAuth`), which says whether the list is the ChatGPT one.
 */
export async function checkCredentialByList(
	provider: Pick<Provider, "id" | "baseUrl" | "getModels" | "headers">,
	auth: ModelAuth,
	options: { signal?: AbortSignal; fetch?: typeof fetch; credentialSource?: string } = {},
): Promise<ListCredentialCheck | undefined> {
	const source = MODEL_DISCOVERY_SOURCES[provider.id];
	if (!source?.path || source.public) return undefined;
	try {
		return {
			ok: true,
			models: await requestVendorModels(provider, auth, {
				signal: options.signal,
				fetch: options.fetch,
				chatGPT: isChatGPTLogin(provider.id, options.credentialSource),
			}),
		};
	} catch (error) {
		options.signal?.throwIfAborted();
		return { ok: false, detail: error instanceof Error ? error.message : "Vendor model list failed" };
	}
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
			chatGPT: isChatGPTLogin(providerId, resolved.source),
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
