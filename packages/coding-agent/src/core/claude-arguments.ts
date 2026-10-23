/** Claude placeholders are zero-based and preserve the unparsed argument string. */
export function expandClaudeArguments(
	body: string,
	raw: string,
	args: readonly string[],
	names: readonly string[] = [],
): string {
	let consumed = false;
	const expanded = body.replace(
		/(\\*)\$(ARGUMENTS\[\d+\]|\d+|[A-Za-z_]\w*)/g,
		(match, slashes: string, token: string) => {
			const named = names.indexOf(token);
			const indexed = /^(?:ARGUMENTS\[(\d+)\]|(\d+))$/.exec(token);
			if (token !== "ARGUMENTS" && !indexed && named < 0) return match;
			if (slashes.length === 1) return `$${token}`;
			if (token === "ARGUMENTS") {
				consumed = true;
				return slashes + raw;
			}
			const index = indexed ? Number(indexed[1] ?? indexed[2]) : named;
			if (indexed && args[index] === undefined) return match;
			consumed = true;
			return slashes + (args[index] ?? "");
		},
	);
	return !consumed && raw.trim() ? `${expanded}\n\nARGUMENTS: ${raw}` : expanded;
}

export function claudeArgumentNames(value: unknown): string[] {
	if (value === undefined) return [];
	const names = typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : value;
	if (!Array.isArray(names) || !names.every((name) => typeof name === "string" && /^[A-Za-z_]\w*$/.test(name)))
		throw new Error("arguments must be a list of argument names or a whitespace-separated string");
	return names;
}

export interface ClaudeVariables {
	sessionId?: string;
	projectDir?: string;
	skillDir?: string;
	pluginRoot?: string;
	pluginData?: string;
}

/** Substitute known host values once, after positional arguments have been inserted. */
export function expandClaudeVariables(body: string, values: ClaudeVariables): string {
	const variables: Record<string, string | undefined> = {
		CLAUDE_SESSION_ID: values.sessionId,
		CLAUDE_PROJECT_DIR: values.projectDir,
		CLAUDE_SKILL_DIR: values.skillDir,
		CLAUDE_PLUGIN_ROOT: values.pluginRoot,
		CLAUDE_PLUGIN_DATA: values.pluginData,
	};
	return body.replace(/\$\{(CLAUDE_[A-Z_]+)\}/g, (token, name: string) => variables[name] ?? token);
}
