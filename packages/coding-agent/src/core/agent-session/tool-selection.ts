/** Whether a session's tool selection can reach a group of tools before they are registered, such as one MCP server's. */

export interface ToolSelection {
	/** `--tools` entries: tool names or `*` patterns; undefined without an allowlist. */
	allowed?: readonly string[];
	/** `--exclude-tools` entries. */
	excluded: readonly string[];
	/** `--tools` `+`/`-` entries and the `defaultTools` setting: exact tool names. */
	modifiers: readonly string[];
}

/**
 * Whether the selection can activate tools named `<prefix>…`, such as the tools of one MCP server (`mcp__<server>__`),
 * so a feature knows whether starting their source is worth it. Tools active by default are selected unless excluded
 * or outside the allowlist, where any entry that can match such a name counts. Others need an entry that names them: an
 * allowlist entry starting with the prefix (not a broad `*` or `mcp__*`), or an exact name among the modifiers.
 */
export function selectsToolPrefix(prefix: string, activeByDefault: boolean, selection: ToolSelection): boolean {
	const names = (entry: string) => entry.split("*", 1)[0].startsWith(prefix);
	const reaches = (entry: string) => names(entry) || (entry.includes("*") && prefix.startsWith(entry.split("*", 1)[0]));
	// An exclusion removes every such tool only as the prefix (or a shorter one) with a single trailing `*`.
	const removesAll = (entry: string) => /^[^*]*\*$/.test(entry) && prefix.startsWith(entry.slice(0, -1));
	if (selection.excluded.some(removesAll)) return false;
	if (selection.allowed) return selection.allowed.some(activeByDefault ? reaches : names);
	return (
		activeByDefault ||
		selection.modifiers.some(
			(entry) => !entry.startsWith("-") && !entry.includes("*") && entry.replace(/^\+/, "").startsWith(prefix),
		)
	);
}
