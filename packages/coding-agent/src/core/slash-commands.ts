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
	requiresNative?: boolean;
	name: string;
	aliases?: readonly string[];
	description: string;
	argumentHint?: string;
	argumentValues?: readonly string[];
	argumentKind?: "path";
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "permissions",
		requiresNative: true,
		aliases: ["allowed-tools"],
		description: "Inspect or change native permissions",
		argumentHint: "<mode|grants|log|plan>",
	},
	{
		name: "agents",
		requiresNative: true,
		aliases: ["list-agents", "peers"],
		description: "List or control native and external agents",
		argumentHint: "<operation>",
	},
	{
		name: "plan",
		requiresNative: true,
		description: "Enter native planning or review the current plan",
		argumentHint: "<description|--off|--approve revision>",
	},
	{
		name: "btw",
		description: "Ask a tool-free side question outside conversation history",
		argumentHint: "<question|--clear>",
	},
	{
		name: "context",
		description: "Inspect context usage or set this session's context budget",
		argumentHint: "<all|size|reset|tokens>",
		argumentValues: ["all", "size", "reset"],
	},
	{
		name: "diff",
		description: "Inspect staged, unstaged and untracked repository changes",
		argumentHint: "<path>",
		argumentKind: "path",
	},
	{ name: "help", description: "Find commands", argumentHint: "<search>" },
	{ name: "settings", aliases: ["config"], description: "Open settings menu" },
	{
		name: "model",
		aliases: ["models"],
		description: "Choose the AI model for this chat, grouped by provider",
		argumentHint: "<provider/model>",
	},
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{
		name: "effort",
		aliases: ["thinking"],
		description: "Set the coordinator's reasoning effort",
		argumentHint: "<level>",
	},
	{ name: "modelsettings", description: "Configure model shortcuts; inspect prices and agent routing" },
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
	{ name: "rename", description: "Set session display name", argumentHint: "<name>" },
	{
		name: "status",
		aliases: ["usage", "cost", "stats"],
		description: "Show session statistics, skills and MCP status",
	},
	{ name: "changelog", aliases: ["release-notes"], description: "Show changelog entries" },
	{ name: "keys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "queue", description: "Edit, remove or reorder queued messages" },
	{
		name: "trust",
		description: "Manage project resource and native configuration trust",
		argumentHint: "<project|config|off>",
		argumentValues: ["project", "config", "off"],
	},
	{
		name: "providers",
		aliases: ["login"],
		description: "Connect AI providers; view status, update or remove credentials",
		argumentHint: "<provider|pi>",
	},
	{ name: "logout", description: "Remove a saved AI provider credential; external credentials stay unchanged" },
	{
		name: "github",
		description: "Manage GitHub code-search access; AI model access uses /providers",
		argumentHint: "<status|login|logout>",
		argumentValues: ["status", "login", "logout"],
	},
	{ name: "new", aliases: ["clear", "reset"], description: "Start a new session", argumentHint: "<previous-name>" },
	{ name: "compact", description: "Manually compact the session context", argumentHint: "<instructions>" },
	{ name: "resume", aliases: ["continue"], description: "Browse and resume saved sessions", argumentHint: "<search>" },
	{ name: "skills", description: "Find and use a loaded skill", argumentHint: "<search>" },
	{ name: "debug", description: "Save local terminal and session diagnostics" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", aliases: ["exit"], description: `Quit ${APP_NAME}` },
];

/** A command whose names prompt and skill commands must not take. */
export interface CommandReservation {
	name: string;
	invocationName?: string;
	aliases?: readonly string[];
	invocationAliases?: readonly string[];
}

/** Names taken by the built-in commands and `reservedCommands`. */
export function reservedCommandNames(reservedCommands: readonly CommandReservation[]): Set<string> {
	const reserved = new Set<string>();
	for (const command of [...BUILTIN_SLASH_COMMANDS, ...reservedCommands] as CommandReservation[]) {
		reserved.add(command.name);
		for (const name of commandNames(command)) reserved.add(name);
		if (command.invocationName) reserved.add(command.invocationName);
	}
	return reserved;
}

/** Spellings owned by one command; resolved extension aliases take precedence over declarations. */
export function commandNames(command: CommandReservation): string[] {
	return [command.invocationName ?? command.name, ...(command.invocationAliases ?? command.aliases ?? [])];
}

export function validateCommandAliases(name: string, aliases: readonly string[] = []): void {
	if (!Array.isArray(aliases)) throw new Error("Command aliases must be an array of strings.");
	const seen = new Set([name]);
	for (const alias of aliases) {
		if (typeof alias !== "string" || !/^[a-z]+(?:-[a-z]+)*$/.test(alias) || seen.has(alias))
			throw new Error(`Invalid or duplicate command alias: ${alias}`);
		seen.add(alias);
	}
}

export function getBuiltinCommand(name: string): BuiltinSlashCommand | undefined {
	return BUILTIN_SLASH_COMMANDS.find((command) => commandNames(command).includes(name));
}

export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { name: match[1], args: match[2] ?? "" } : undefined;
}
