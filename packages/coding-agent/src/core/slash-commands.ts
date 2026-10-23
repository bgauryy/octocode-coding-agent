import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	aliases?: readonly string[];
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	aliases?: readonly string[];
	description: string;
	argumentHint?: string;
	argumentValues?: readonly string[];
	argumentKind?: "path";
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "help", aliases: ["commands"], description: "Find commands and their aliases", argumentHint: "<search>" },
	{ name: "settings", aliases: ["config"], description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "effort", aliases: ["thinking", "reasoning"], description: "Set reasoning effort", argumentHint: "<level>" },
	{ name: "models", aliases: ["scoped-models"], description: "Manage model cycling, catalog and agent routing" },
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
	{ name: "share", description: "Share session as a private GitHub gist" },
	{
		name: "bug",
		aliases: ["feedback"],
		description: "Report a bug to the Octocode developers",
		argumentHint: "<description>",
	},
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "rename", aliases: ["name"], description: "Set session display name", argumentHint: "<name>" },
	{ name: "status", aliases: ["info", "session"], description: "Show session statistics, skills and MCP status" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "keys", aliases: ["hotkeys"], description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{
		name: "trust",
		description: "Manage project resource and native configuration trust",
		argumentHint: "<project|config|off>",
		argumentValues: ["project", "config", "off"],
	},
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", aliases: ["clear"], description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", aliases: ["sessions"], description: "Browse and resume saved sessions", argumentHint: "<search>" },
	{ name: "skills", description: "Find and use a loaded skill", argumentHint: "<search>" },
	{ name: "debug", description: "Save local terminal and session diagnostics" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", aliases: ["exit"], description: `Quit ${APP_NAME}` },
];

export function getBuiltinCommand(name: string): BuiltinSlashCommand | undefined {
	return BUILTIN_SLASH_COMMANDS.find((command) => command.name === name || command.aliases?.includes(name));
}

export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { name: match[1], args: match[2] ?? "" } : undefined;
}
