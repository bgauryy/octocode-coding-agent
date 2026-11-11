import { readFileSync, statSync } from "node:fs";
// Parsing only: this module must not import `config-value.ts`, which imports the shell module that imports this one.
import { getConfigValueEnvVarNames, isCommandConfigValue } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { stripJsonComments } from "../../../common/src/json.ts";
import { stripBom } from "../../../common/src/text.ts";

/** The `apiKey` a local server's provider template writes: it marks the provider usable and is no secret. */
export const NO_KEY = "no-key";

/**
 * The `apiKey` values a `models.json` holds, as written, and its `headers` values (they resolve like `apiKey`). A value
 * is a `!command`, a template with environment references, or a literal. Unreadable or malformed files hold none: the
 * model loader reports those.
 */
interface KeyValues {
	keys: string[];
	headers: string[];
}
const cache = new Map<string, { stamp: string; values: KeyValues }>();

function collect(node: unknown, out: KeyValues, depth = 0): void {
	if (depth > 8 || typeof node !== "object" || node === null) return;
	for (const [name, value] of Object.entries(node)) {
		if (name === "apiKey" && typeof value === "string") out.keys.push(value);
		else if (name === "headers" && typeof value === "object" && value !== null)
			out.headers.push(...Object.values(value).filter((entry): entry is string => typeof entry === "string"));
		else collect(value, out, depth + 1);
	}
}

function modelsKeyValues(file: string): KeyValues {
	try {
		const stat = statSync(file);
		const stamp = `${stat.mtimeMs}:${stat.size}`;
		const hit = cache.get(file);
		if (hit?.stamp === stamp) return hit.values;
		const values: KeyValues = { keys: [], headers: [] };
		// Read the way the model loader reads it (comments, a BOM), so a commented file still yields its keys.
		collect(JSON.parse(stripJsonComments(stripBom(readFileSync(file, "utf8")))), values);
		cache.set(file, { stamp, values });
		return values;
	} catch {
		return { keys: [], headers: [] };
	}
}

/** Whether `value` is the key itself: not a `!command`, a template with an environment reference or the `NO_KEY` marker. */
const isLiteralApiKey = (value: string): boolean =>
	value.trim() !== "" &&
	value !== NO_KEY &&
	!isCommandConfigValue(value) &&
	getConfigValueEnvVarNames(value).length === 0;

/** Whether the `models.json` at `file` holds a literal `apiKey`. */
export const modelsFileHoldsLiteralKey = (file: string): boolean => modelsKeyValues(file).keys.some(isLiteralApiKey);

/** The environment variable names the `models.json` at `file` takes provider keys and header values from. */
export const modelsEnvKeyNames = (file: string): string[] => {
	const { keys, headers } = modelsKeyValues(file);
	return [...new Set([...keys, ...headers].flatMap(getConfigValueEnvVarNames))];
};
