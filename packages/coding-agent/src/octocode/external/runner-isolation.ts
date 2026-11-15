/** Claude's launch options preserve sign-in while excluding ambient skills, settings and MCP servers. */
export const claudeIsolationOptions = () => ({
	settingSources: [],
	strictMcpConfig: true,
	extraArgs: { "disable-slash-commands": null },
});

export const runnerSessionMeta = (vendor: string): Record<string, unknown> | undefined =>
	vendor === "claude-code" ? { claudeCode: { options: claudeIsolationOptions() } } : undefined;

/** Gemini's per-launch allowlist restricts MCP to the explicit bridge without overriding workspace trust. */
export const runnerLaunchArgs = (vendor: string, args: readonly string[], bridge?: string): string[] => [
	...args,
	...(vendor === "gemini" && bridge ? [`--allowed-mcp-server-names=${bridge}`] : []),
];

export const CLAUDE_ISOLATION_ARGS = [
	"--setting-sources",
	"",
	"--strict-mcp-config",
	"--disable-slash-commands",
] as const;
