import type { ProviderHeaders } from "../types.ts";

export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

/** `base` with `override` applied; an override replaces every case-variant of its header name. */
export function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

export function providerHeadersToRecord(
	...headerSources: (ProviderHeaders | undefined)[]
): Record<string, string> | undefined {
	const merged = new Map<string, [string, string]>();
	for (const source of headerSources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			const normalizedName = name.toLowerCase();
			merged.delete(normalizedName);
			if (value !== null) merged.set(normalizedName, [name, value]);
		}
	}
	return merged.size > 0 ? Object.fromEntries(merged.values()) : undefined;
}

/** Whether `headers` carries a non-empty value for `name` (case-insensitive). */
export function hasProviderHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

/**
 * API key for an OpenAI SDK client. A gateway that authenticates through headers
 * needs no key, so the SDK receives a placeholder.
 */
export function getClientApiKey(
	provider: string,
	apiKey: string | undefined,
	headers: ProviderHeaders | undefined,
): string {
	if (apiKey) return apiKey;
	if (hasProviderHeader(headers, "authorization") || hasProviderHeader(headers, "cf-aig-authorization"))
		return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}
