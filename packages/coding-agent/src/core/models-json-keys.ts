import { readFileSync, statSync } from "node:fs";
// Parsing only: this module must not import `config-value.ts`, which imports the shell module that imports this one.
import { getConfigValueEnvVarNames, isCommandConfigValue } from "@octocodeai/octocode-ai/utils/resolve-config-value";

/**
 * The `apiKey` values a `models.json` holds, as written. A value is a `!command`, a template with environment references, or a literal key. Unreadable or malformed files hold none: the model loader reports those.
 */
const cache = new Map<string, { stamp: string; values: string[] }>();

function collect(node: unknown, out: string[], depth = 0): void {
	if (depth > 8 || typeof node !== "object" || node === null) return;
	for (const [name, value] of Object.entries(node)) {
		if (name === "apiKey" && typeof value === "string") out.push(value);
		else collect(value, out, depth + 1);
	}
}

export function modelsApiKeyValues(file: string): string[] {
	try {
		const stat = statSync(file);
		const stamp = `${stat.mtimeMs}:${stat.size}`;
		const hit = cache.get(file);
		if (hit?.stamp === stamp) return hit.values;
		const values: string[] = [];
		collect(JSON.parse(readFileSync(file, "utf8")), values);
		cache.set(file, { stamp, values });
		return values;
	} catch {
		return [];
	}
}

/** Whether `value` is the key itself: neither a `!command` nor a template with an environment reference. */
export const isLiteralApiKey = (value: string): boolean =>
	value.trim() !== "" && !isCommandConfigValue(value) && getConfigValueEnvVarNames(value).length === 0;

/** Whether the `models.json` at `file` holds a literal `apiKey`. */
export const modelsFileHoldsLiteralKey = (file: string): boolean => modelsApiKeyValues(file).some(isLiteralApiKey);

/** The environment variable names the `models.json` at `file` takes provider keys from. */
export const modelsEnvKeyNames = (file: string): string[] => [
	...new Set(modelsApiKeyValues(file).flatMap(getConfigValueEnvVarNames)),
];
