/**
 * Escape a value Octocode generates (a workspace or skill path) so the `${VAR}` and `!command` resolution that every
 * configured `env` value goes through returns it unchanged: `$` becomes `$$`, and a leading `!` becomes `$!`.
 */
export function literalConfigValue(value: string): string {
	return value.replaceAll("$", "$$$$").replace(/^!/, "$!");
}

export function literalConfigEnv(env: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, literalConfigValue(value)]));
}
