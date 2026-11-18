import { APP_TITLE } from "../config.ts";
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
	/** An alias typed from habit: it runs, but the `/` menu and the /help picker leave it out. */
	menuHidden?: true;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "permissions",
		requiresNative: true,
		description: "What Octocode asks before it acts",
		argumentHint: "[manual|workspace|full|grants [clear [messages]]|log]",
	},
	{
		name: "agents",
		requiresNative: true,
		description: "List, message, stop or connect agents",
		argumentHint: "[tell|interrupt|kill|merge|stats|history|external]",
	},
	{
		name: "messages",
		requiresNative: true,
		description: "Every agent's mail: who sent what to whom",
		argumentHint: "[internal]",
		argumentValues: ["internal"],
	},
	{
		name: "cron",
		requiresNative: true,
		description: "List or delete scheduled tasks",
		argumentHint: "[list|delete <id>]",
		argumentValues: ["list", "delete"],
	},
	{
		name: "monitor",
		requiresNative: true,
		description: "Show every monitor rule with its alert counts",
		argumentHint: "[text]",
		argumentValues: ["text"],
	},
	{
		name: "loop",
		requiresNative: true,
		description: "Run a prompt on a repeating schedule",
		argumentHint: "<5m|1h|1d> <prompt>",
	},
	{
		name: "realm",
		requiresNative: true,
		description: "See the checkout, worktrees and sessions",
		argumentHint: "[<name> [switch|resume]]",
	},
	{
		name: "plan",
		requiresNative: true,
		description: "Research under a planning constraint",
		argumentHint: "[description|--show|--off|--approve <revision>]",
	},
	{
		name: "btw",
		description: "Ask a side question without tools",
		argumentHint: "[question|--cancel|--clear]",
	},
	{
		name: "context",
		description: "Show or set how much history the model sees",
		argumentHint: "[all|size|reset|full|<tokens>]",
		argumentValues: ["all", "size", "reset", "full"],
	},
	{
		name: "diff",
		description: "Show repository changes",
		argumentHint: "[path|--editor <before> <after>]",
		argumentKind: "path",
	},
	{ name: "help", description: "Find a command, or show one's usage", argumentHint: "[command|search]" },
	{
		name: "configuration",
		description: "View and change settings",
		argumentHint: "[list|get|enable|disable|set|unset|add|remove] [--local]",
		argumentValues: ["list", "get", "enable", "disable", "set", "unset", "add", "remove"],
	},
	{
		name: "model",
		description: "Pick a model for this chat or as the default",
		argumentHint: "[provider/model] [--set-default]",
	},
	{ name: "tree", description: "Browse session branches and jump to a message" },
	{
		name: "effort",
		description: "Set reasoning effort: how hard the model thinks",
		argumentHint: "[level]",
	},
	{
		name: "modelsettings",
		description: "Model shortcuts, prices and subagent routing",
		argumentHint: "[check]",
	},
	{
		name: "export",
		description: "Save this session as an HTML or JSONL file",
		argumentHint: "[path]",
		argumentKind: "path",
	},
	{
		name: "import",
		description: "Open a session from an exported file",
		argumentHint: "<path>",
		argumentKind: "path",
	},
	{ name: "share", description: "Share this session as a private GitHub gist" },
	{
		name: "bug",
		description: "Report a bug to the developers",
		argumentHint: "[description]",
	},
	{
		name: "copy",
		description: "Copy an answer, code or file location",
		argumentHint: "[message|markdown|references|code|location]",
		argumentValues: ["message", "markdown", "references", "code", "location"],
	},
	{
		name: "links",
		description: "Find, inspect, open or copy references",
		argumentHint: "[message|all] [query]",
		argumentValues: ["message", "all"],
	},
	{ name: "rename", description: "Rename this session", argumentHint: "<name>" },
	{
		name: "status",
		description: "Show session usage, skills and MCP status",
	},
	{ name: "changelog", description: "Show what's new" },
	{ name: "keys", description: "Show keyboard shortcuts" },
	{
		name: "fork",
		description: "Start a new session from an earlier message",
		argumentHint: "[pane [right|down]|window]",
		argumentValues: ["pane", "window"],
	},
	{ name: "clone", description: "Copy this whole session into a new one" },
	{ name: "queue", description: "Edit queued messages" },
	{
		name: "providers",
		description: "Connect, enable or disable AI providers",
		argumentHint: "[provider|pi]",
	},
	{ name: "logout", description: "Remove a saved provider credential", argumentHint: "[provider]" },
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
		menuHidden: true,
	},
	{
		name: "reset",
		description: "Start a new session (same as /new)",
		argumentHint: "[name-for-current-session]",
		menuHidden: true,
	},
	{ name: "compact", description: "Summarize older turns to free context", argumentHint: "[instructions]" },
	{ name: "resume", description: "Reopen a recent session in this folder", argumentHint: "[all] [<query>|B<n>]" },
	{
		name: "debug",
		description: "Show terminal health or save redacted diagnostics",
		argumentHint: "[terminal]",
		argumentValues: ["terminal"],
	},
	{ name: "reload", description: "Reload settings, skills and themes" },
	{ name: "quit", description: `Quit ${APP_TITLE}` },
];

/**
 * The `/` menu's order, by what a user is doing: get started, work in the session, run agents, configure, then
 * leave or report. Commands not listed follow in registration order, and skills come last.
 */
export const SLASH_MENU_ORDER: readonly string[] = [
	"help",
	"model",
	"providers",
	"effort",
	"new",
	"resume",
	"compact",
	"context",
	"status",
	"btw",
	"plan",
	"diff",
	"rewind",
	"tree",
	"fork",
	"clone",
	"rename",
	"queue",
	"copy",
	"links",
	"agents",
	"messages",
	"jobs",
	"worktree",
	"realm",
	"backlog",
	"processes",
	"monitor",
	"memory",
	"archive",
	"permissions",
	"configuration",
	"modelsettings",
	"harness",
	"mcp",
	"trust",
	"keys",
	"optimize",
	"reload",
	"web",
	"remote",
	"api",
	"octocode",
	"export",
	"import",
	"share",
	"changelog",
	"debug",
	"bug",
	"logout",
	"purge",
	"quit",
];

/**
 * Names Claude Code users type from habit, each run as the Octocode command it maps to. The `/` menu shows only the
 * target; `/clear` and `/reset` stay separate hidden entries of `/new`.
 */
export const COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([
	["exit", "quit"],
	["config", "configuration"],
	["settings", "configuration"],
	["release-notes", "changelog"],
	["feedback", "bug"],
	["login", "providers"],
	["continue", "resume"],
	["allowed-tools", "permissions"],
	["doctor", "debug"],
	["checkpoint", "rewind"],
	["todos", "backlog"],
	["bashes", "processes"],
]);

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
	for (const alias of COMMAND_ALIASES.keys()) reserved.add(alias);
	return reserved;
}

/** The one description of a built-in command; a native registration of the same name reuses it rather than repeating it. */
export function builtinDescription(name: string): string {
	const command = getBuiltinCommand(name);
	if (!command) throw new Error(`/${name} is not a built-in command.`);
	return command.description;
}

export function getBuiltinCommand(name: string): BuiltinSlashCommand | undefined {
	return BUILTIN_SLASH_COMMANDS.find((command) => command.name === name);
}

/** The commands a built-in feature registers, by the feature that owns each: with the feature off the name stays known but unavailable. */
const FEATURE_COMMANDS: ReadonlyMap<string, string> = new Map([["mcp", "mcp"]]);

/** The built-in feature that owns slash command `name`, if one does. */
export const featureOfCommand = (name: string): string | undefined => FEATURE_COMMANDS.get(name);

export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	return match ? { name: COMMAND_ALIASES.get(match[1]) ?? match[1], args: match[2] ?? "" } : undefined;
}
