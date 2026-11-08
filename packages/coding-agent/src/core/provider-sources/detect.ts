import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { DetectedTool, DetectedToolAction, ProviderSourceEnvironment, ProviderSourceFs } from "./types.ts";

export const nodeProviderSourceFs: ProviderSourceFs = {
	exists: (path) => existsSync(path),
	realpath: (path) => {
		try {
			return realpathSync(path);
		} catch {
			return undefined;
		}
	},
};

interface Locations {
	home: string;
	env: Readonly<Record<string, string | undefined>>;
}

interface ToolDefinition {
	id: string;
	label: string;
	action: DetectedToolAction;
	/** Documented install and config paths, existence only. Never a bare command name, never a credential file. */
	paths(at: Locations): readonly string[];
	/** A launcher that counts only when it resolves into the tool's own install (`agent` can be Grok or Cursor). */
	launchers?: readonly { path(at: Locations): string; resolvesTo: RegExp }[];
}

const fromEnv = ({ env, home }: Locations, name: string, fallback: string) => {
	const value = env[name]?.trim();
	return value ? (isAbsolute(value) ? value : resolve(home, value)) : fallback;
};
const configHome = (at: Locations) => fromEnv(at, "XDG_CONFIG_HOME", join(at.home, ".config"));
const dataHome = (at: Locations) => fromEnv(at, "XDG_DATA_HOME", join(at.home, ".local", "share"));

/** Detected tools, from the documented paths in `.octocode/providers/local-sources.md`. */
const TOOLS: readonly ToolDefinition[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		action: { kind: "api-key", providerId: "anthropic" },
		paths: (at) => [fromEnv(at, "CLAUDE_CONFIG_DIR", join(at.home, ".claude")), join(at.home, ".claude.json")],
	},
	{
		id: "codex-cli",
		label: "Codex CLI",
		action: { kind: "sign-in", providerId: "openai-codex", alternativeProviderIds: ["openai-chatgpt"] },
		paths: (at) => [fromEnv(at, "CODEX_HOME", join(at.home, ".codex"))],
	},
	{
		id: "grok-cli",
		label: "Grok CLI",
		action: { kind: "sign-in", providerId: "xai" },
		paths: (at) => [fromEnv(at, "GROK_HOME", join(at.home, ".grok"))],
	},
	{
		id: "gemini-cli",
		label: "Gemini CLI",
		action: { kind: "api-key", providerId: "google" },
		paths: (at) => [join(at.home, ".gemini")],
	},
	{
		id: "cursor",
		label: "Cursor",
		action: { kind: "api-key", providerId: "openai" },
		paths: (at) => [
			join(at.home, ".cursor"),
			join(at.home, ".local", "bin", "cursor-agent"),
			join(at.home, "Library", "Application Support", "Cursor"),
			join(configHome(at), "Cursor"),
		],
		launchers: [{ path: (at) => join(at.home, ".local", "bin", "agent"), resolvesTo: /cursor/i }],
	},
	{
		id: "opencode",
		label: "opencode",
		action: { kind: "api-key", providerId: "opencode" },
		paths: (at) => [join(configHome(at), "opencode"), join(dataHome(at), "opencode")],
	},
	{
		id: "crush",
		label: "crush",
		action: { kind: "api-key", providerId: "openrouter" },
		paths: (at) => [fromEnv(at, "CRUSH_DATA_DIR", join(dataHome(at), "crush")), join(configHome(at), "crush")],
	},
	{
		id: "copilot-cli",
		label: "Copilot CLI",
		action: { kind: "sign-in", providerId: "github-copilot" },
		paths: (at) => [fromEnv(at, "COPILOT_HOME", join(at.home, ".copilot"))],
	},
	{
		id: "qwen-code",
		label: "Qwen Code",
		action: { kind: "api-key", providerId: "qwen-token-plan" },
		paths: (at) => [join(at.home, ".qwen")],
	},
	{
		id: "aider",
		label: "Aider",
		action: { kind: "api-key", providerId: "openai" },
		paths: (at) => [join(at.home, ".aider.conf.yml"), join(at.home, ".aider")],
	},
];

/** `~`-relative form for display. */
export function displayPath(path: string, home: string): string {
	return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * Local tools found by their documented install or config paths. Only existence is checked: no file is opened, and no
 * keychain or credential store is touched.
 */
export function detectLocalTools(options: ProviderSourceEnvironment = {}): DetectedTool[] {
	const at: Locations = { home: options.home ?? homedir(), env: options.env ?? process.env };
	const fs = options.fs ?? nodeProviderSourceFs;
	const found: DetectedTool[] = [];
	for (const tool of TOOLS) {
		const present = tool.paths(at).filter((path) => fs.exists(path));
		for (const launcher of tool.launchers ?? []) {
			const path = launcher.path(at);
			const target = fs.exists(path) ? fs.realpath(path) : undefined;
			if (target && launcher.resolvesTo.test(target)) present.push(path);
		}
		if (present.length === 0) continue;
		found.push({
			id: tool.id,
			label: tool.label,
			foundAt: present.map((path) => displayPath(path, at.home)),
			action: tool.action,
		});
	}
	return found;
}
