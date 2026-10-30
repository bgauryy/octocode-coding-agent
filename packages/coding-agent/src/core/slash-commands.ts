import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	requiresNative?: boolean;
	name: string;
	description: string;
	argumentHint?: string;
	argumentValues?: readonly string[];
	argumentKind?: "path";
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "permissions",
		requiresNative: true,
		description: "Inspect or change native permissions",
		argumentHint: "<mode|grants|log|plan>",
	},
	{
		name: "agents",
		requiresNative: true,
		description: "List or control native and external agents",
		argumentHint: "<operation>",
	},
	{
		name: "plan",
		requiresNative: true,
		description: "Enter native planning (optionally with a task), show it with --show, leave with --off",
		argumentHint: "<description|--show|--off|--approve revision>",
	},
	{
		name: "btw",
		description: "Ask a tool-free side question outside conversation history",
		argumentHint: "<question|--clear>",
	},
	{
		name: "context",
		description: "Inspect context usage or set this session's context budget",
		argumentHint: "<all|size|reset|full|tokens>",
		argumentValues: ["all", "size", "reset", "full"],
	},
	{
		name: "diff",
		description: "Inspect staged, unstaged and untracked repository changes",
		argumentHint: "<path>",
		argumentKind: "path",
	},
	{ name: "help", description: "Find commands", argumentHint: "<search>" },
	{ name: "settings", description: "Open settings menu" },
	{
		name: "model",
		description: "Choose the AI model for this chat, grouped by provider",
		argumentHint: "<provider/model>",
	},
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{
		name: "effort",
		description: "Set the coordinator's reasoning effort",
		argumentHint: "<level>",
	},
	{
		name: "modelsettings",
		description: "Configure model shortcuts; inspect prices and agent routing",
		argumentHint: "[check]",
	},
	{
		name: "export",
		description: "Export session (HTML default, or specify path: .html/.jsonl)",
		argumentHint: "<path>",
		argumentKind: "path",
	},
	{
		name: "import",
		description: "Import and resume a session from a JSONL file",
		argumentHint: "<path>",
		argumentKind: "path",
	},
	{ name: "share", description: "Share session as a secret GitHub gist (anyone with the link can read it)" },
	{
		name: "bug",
		description: "Report a bug to the Octocode developers",
		argumentHint: "<description>",
	},
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "rename", description: "Set session display name", argumentHint: "<name>" },
	{
		name: "status",
		description: "Show session statistics, skills and MCP status",
	},
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "keys", description: "Show all keyboard shortcuts" },
	{
		name: "fork",
		description: "Create a new fork from a previous user message, or open this session's fork in a tmux pane or window",
		argumentHint: "[pane [right|down]|window]",
		argumentValues: ["pane", "window"],
	},
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "queue", description: "Edit, remove or reorder queued messages" },
	{
		name: "trust",
		description: "Manage project resource and native configuration trust",
		argumentHint: "<project|config|off>",
		argumentValues: ["project", "config", "off"],
	},
	{
		name: "login",
		description: "Connect AI providers; view status, update or remove credentials",
		argumentHint: "<provider|pi>",
	},
	{ name: "logout", description: "Remove a saved AI provider credential; external credentials stay unchanged" },
	{
		name: "github",
		description: "Manage GitHub code-search access; AI model access uses /login",
		argumentHint: "<status|login|logout>",
		argumentValues: ["status", "login", "logout"],
	},
	{
		name: "new",
		description: "Start a new session, optionally naming the one you are leaving",
		argumentHint: "<name-for-current-session>",
	},
	{ name: "compact", description: "Manually compact the session context", argumentHint: "<instructions>" },
	{ name: "resume", description: "Browse and resume saved sessions", argumentHint: "<search>" },
	{
		name: "skills",
		description: "Find, inspect, enable or disable skills",
		argumentHint: "<search|list|info|enable|disable>",
		argumentValues: ["list", "info", "enable", "disable"],
	},
	{ name: "debug", description: "Save local terminal and session diagnostics" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

/** A command whose name prompt and skill commands must not take. */
export interface CommandReservation {
	name: string;
	invocationName?: string;
}

/** Names taken by the built-in commands and `reservedCommands`. */
export function reservedCommandNames(reservedCommands: readonly CommandReservation[]): Set<string> {
	const reserved = new Set<string>();
	for (const command of [...BUILTIN_SLASH_COMMANDS, ...reservedCommands] as CommandReservation[]) {
		reserved.add(command.name);
		if (command.invocationName) reserved.add(command.invocationName);
	}
	return reserved;
}

export function getBuiltinCommand(name: string): BuiltinSlashCommand | undefined {
	return BUILTIN_SLASH_COMMANDS.find((command) => command.name === name);
}

export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { name: match[1], args: match[2] ?? "" } : undefined;
}
