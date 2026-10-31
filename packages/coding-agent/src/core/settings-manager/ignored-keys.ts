import { SettingsSchema } from "../settings-schema.ts";

/** Root keys earlier versions read that no longer have an effect, with what replaced each. */
const REMOVED_KEYS: Readonly<Record<string, string>> = {
	compaction:
		"compaction limits are built in: they follow each model's working window (the `contextBudget` setting or `/context`) and the thinking budgets (`thinkingBudgets`), so `reserveTokens`, `keepRecentTokens`, `enabled` and `modelOverrides` have no effect",
	codemode: "codemode was removed; MCP tools are called directly (see `mcp.json` exposure)",
	autoEnableCodemode: "codemode was removed; MCP tools are called directly (see `mcp.json` exposure)",
};

const KNOWN_KEYS = new Set(Object.keys(SettingsSchema.properties));

/** Root keys of a loaded settings object that Octocode does not read, in file order. */
export function ignoredSettingsKeys(settings: object): string[] {
	return Object.keys(settings).filter((key) => !KNOWN_KEYS.has(key));
}

/** One sentence naming an ignored key and, for a removed one, what replaced it. */
export function describeIgnoredKey(key: string): string {
	const replacement = Object.hasOwn(REMOVED_KEYS, key) ? REMOVED_KEYS[key] : undefined;
	return replacement
		? `Setting "${key}" is ignored: ${replacement}. Remove it from the file.`
		: `Setting "${key}" is not a known setting and is ignored. Check the spelling or remove it.`;
}
