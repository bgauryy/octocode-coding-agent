import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	argumentHint?: string;
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
		description: "Inspect or change permissions",
		argumentHint: "[mode|grants|log|plan]",
	},
	{
		name: "agents",
		requiresNative: true,
		description: "List or control agents",
		argumentHint: "[operation]",
	},
	{
		name: "plan",
		requiresNative: true,
		description: "Plan a task before making changes",
		argumentHint: "[description|--show|--off|--approve revision]",
	},
	{
		name: "btw",
		description: "Ask a quick side question without using tools",
		argumentHint: "[question|--cancel|--clear]",
	},
	{
		name: "context",
		description: "Show or change how much conversation the model can see",
		argumentHint: "[all|size|reset|full|tokens]",
		argumentValues: ["all", "size", "reset", "full"],
	},
	{
		name: "diff",
		description: "Show repository changes",
		argumentHint: "[path]",
		argumentKind: "path",
	},
	{ name: "help", description: "Find commands", argumentHint: "[search]" },
	{ name: "settings", description: "Open settings" },
	{
		name: "model",
		description: "Choose the AI model",
		argumentHint: "[provider/model]",
	},
	{ name: "tree", description: "Navigate the session tree" },
	{
		name: "effort",
		description: "Set reasoning effort",
		argumentHint: "[level]",
	},
	{
		name: "modelsettings",
		description: "Model shortcuts, prices and routing",
		argumentHint: "[check]",
	},
	{
		name: "export",
		description: "Export session to HTML or JSONL",
		argumentHint: "[path]",
		argumentKind: "path",
	},
	{
		name: "import",
		description: "Open a saved session from a file",
		argumentHint: "<path>",
		argumentKind: "path",
	},
	{ name: "share", description: "Share this session as a private GitHub gist" },
	{
		name: "bug",
		description: "Report a bug to the developers",
		argumentHint: "[description]",
	},
	{ name: "copy", description: "Copy last agent message" },
	{ name: "rename", description: "Rename this session", argumentHint: "<name>" },
	{
		name: "status",
		description: "Show session stats, skills and MCP",
	},
	{ name: "changelog", description: "Show the changelog" },
	{ name: "keys", description: "Show keyboard shortcuts" },
	{
		name: "fork",
		description: "Fork from a previous message",
		argumentHint: "[pane [right|down]|window]",
		argumentValues: ["pane", "window"],
	},
	{ name: "clone", description: "Duplicate this session" },
	{ name: "queue", description: "Edit queued messages" },
	{
		name: "login",
		description: "Connect AI providers",
		argumentHint: "[provider|pi]",
	},
	{ name: "logout", description: "Remove a provider credential" },
	{
		name: "new",
		description: "Start a new session",
		argumentHint: "[name-for-current-session]",
	},
	// User request (2026-11-01): the two names users reach for to start over; each runs the /new handler.
	{
		name: "clear",
		description: "Start a new session (same as /new)",
		argumentHint: "[name-for-current-session]",
	},
	{
		name: "reset",
		description: "Start a new session (same as /new)",
		argumentHint: "[name-for-current-session]",
	},
	{ name: "compact", description: "Compact the session context", argumentHint: "[instructions]" },
	{ name: "resume", description: "Browse and resume sessions", argumentHint: "[search]" },
	{
		name: "skills",
		description: "Find, inspect and toggle skills",
		argumentHint: "[search|list|info|enable|disable]",
		argumentValues: ["list", "info", "enable", "disable"],
	},
	{ name: "debug", description: "Save a diagnostics file (screen and messages, secrets redacted)" },
	{ name: "reload", description: "Reload config, skills and themes" },
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

/** The commands a built-in feature registers, by the feature that owns each: with the feature off the name stays known but unavailable. */
const FEATURE_COMMANDS: ReadonlyMap<string, string> = new Map([
	["mcp", "mcp"],
	["llama", "llama.cpp"],
]);

/** The built-in feature that owns slash command `name`, if one does. */
export const featureOfCommand = (name: string): string | undefined => FEATURE_COMMANDS.get(name);

export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { name: match[1], args: match[2] ?? "" } : undefined;
}
