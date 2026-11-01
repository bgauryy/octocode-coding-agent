import { SettingsSchema } from "../settings-schema.ts";
import { RENAMED_TOOLS } from "../tools/tool-names.ts";

/** Root keys earlier versions read that no longer have an effect, with what replaced each (completes "is no longer used: "). */
const REMOVED_KEYS: Readonly<Record<string, string>> = {
	compaction:
		'the whole block (enabled, reserveTokens, keepRecentTokens, modelOverrides) does nothing, because Octocode now decides when to compact from each model\'s context window. To compact earlier, set a smaller "contextBudget" (or use /context size for one session)',
	codemode: "codemode was removed; MCP tools are called directly (see `mcp.json` exposure)",
	autoEnableCodemode: "codemode was removed; MCP tools are called directly (see `mcp.json` exposure)",
};

/** Tool names earlier versions registered that no longer exist, with what replaced each. */
const REMOVED_TOOLS: Readonly<Record<string, string>> = {
	browser:
		'the native `browser` tool was removed; browsing uses the built-in `browser` MCP server (`mcp__browser__*`), which the `browser` subagent selects, or `{ "mcpServers": { "browser": { "defaultActive": true } } }` in `mcp.json` for every agent. Visible-Chrome logins saved under `browser-profile` in the Octocode home are not reused: sign in again in a visible browser session',
};

const KNOWN_KEYS = new Set(Object.keys(SettingsSchema.properties));

/** Root keys of a loaded settings object that Octocode does not read, in file order. */
export function ignoredSettingsKeys(settings: object): string[] {
	return Object.keys(settings).filter((key) => !KNOWN_KEYS.has(key));
}

/** A sentence for each `defaultTools` entry (`browser`, `+browser`, `-browser`) that names a removed or renamed tool, in list order. */
export function removedToolWarnings(settings: { defaultTools?: unknown }): string[] {
	if (!Array.isArray(settings.defaultTools)) return [];
	return settings.defaultTools.flatMap((entry): string[] => {
		const name = typeof entry === "string" ? entry.replace(/^[+-]/, "") : "";
		if (Object.hasOwn(RENAMED_TOOLS, name))
			return [
				`Setting "defaultTools" entry "${entry}" names the old name of "${RENAMED_TOOLS[name]}"; it selects "${RENAMED_TOOLS[name]}" for this release only. Write "${RENAMED_TOOLS[name]}" instead.`,
			];
		return Object.hasOwn(REMOVED_TOOLS, name)
			? [`Setting "defaultTools" entry "${entry}" has no effect: ${REMOVED_TOOLS[name]}. Remove it from the file.`]
			: [];
	});
}

/** One sentence naming an ignored key and, for a removed one, what replaced it. */
export function describeIgnoredKey(key: string): string {
	const replacement = Object.hasOwn(REMOVED_KEYS, key) ? REMOVED_KEYS[key] : undefined;
	return replacement
		? `Setting "${key}" is no longer used: ${replacement}. Delete "${key}" from the file to hide this warning.`
		: `Setting "${key}" is not a known setting, so it does nothing. Check the spelling, or delete it from the file.`;
}
