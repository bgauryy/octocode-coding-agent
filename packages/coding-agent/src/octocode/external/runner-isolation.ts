import { randomUUID } from "node:crypto";

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
	// Gemini treats an empty allowlist as unrestricted. A fresh unmatched name admits no configured server.
	...(vendor === "gemini"
		? ["--extensions=none", `--allowed-mcp-server-names=${bridge ?? `octocode-none-${randomUUID()}`}`]
		: []),
];

export const CLAUDE_ISOLATION_ARGS = [
	"--setting-sources",
	"",
	"--strict-mcp-config",
	"--disable-slash-commands",
] as const;
