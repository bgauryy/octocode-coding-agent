import type { DescriptionOverrides } from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

const OVERRIDE_KEYS: ReadonlySet<string> = new Set(["server", "tools", "triggers", "fields"]);

const isFieldsRecord = (value: unknown): value is Record<string, Record<string, string>> =>
	isRecord(value) && Object.values(value).every(isStringRecord);

/**
 * Validates overrides read from JSON (a file, a store or a preset): `server` is a string, `tools` and `triggers` map
 * tool names to strings, `fields` maps tool names to maps from field path to string. Unknown keys are rejected so a
 * typo (`tool`) does not pass silently.
 */
export function parseOverrides(value: unknown): { overrides: DescriptionOverrides } | { error: string } {
	if (!isRecord(value)) return { error: "overrides must be a JSON object" };
	const unknown = Object.keys(value).filter((key) => !OVERRIDE_KEYS.has(key));
	if (unknown.length)
		return { error: `unknown overrides key${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}` };
	if (value.server !== undefined && typeof value.server !== "string") return { error: '"server" must be a string' };
	if (value.tools !== undefined && !isStringRecord(value.tools))
		return { error: '"tools" must map tool names to strings' };
	if (value.triggers !== undefined && !isStringRecord(value.triggers))
		return { error: '"triggers" must map tool names to strings' };
	if (value.fields !== undefined && !isFieldsRecord(value.fields))
		return { error: '"fields" must map tool names to maps from field path to string' };
	const overrides: DescriptionOverrides = {
		...(value.server === undefined ? {} : { server: value.server }),
		...(value.tools === undefined ? {} : { tools: value.tools }),
		...(value.triggers === undefined ? {} : { triggers: value.triggers }),
		...(value.fields === undefined ? {} : { fields: value.fields }),
	};
	return { overrides };
}
