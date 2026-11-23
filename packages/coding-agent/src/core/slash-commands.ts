import { APP_TITLE } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	argumentHint?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
	/** A skill command's `metadata.triggers`. */
	triggers?: readonly string[];
}

export interface BuiltinSlashCommand {
	requiresNative?: boolean;
	name: string;
	description: string;
	argumentHint?: string;
	argumentValues?: readonly string[];
	argumentKind?: "path";
	/**
	 * A name typed from habit that runs like this other command: it runs, but the `/` menu and the /help picker list it
	 * only as another name on that command's row.
	 */
	menuAliasOf?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "permissions",
		requiresNative: true,
		description: "What Octocode asks before it acts",
		argumentHint: "[manual|workspace|full|grants [clear [messages]]|log|plan [off]]",
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
		argumentHint: "<interval> <prompt>",
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
		name: "settings",
		description: "View and change settings",
		argumentHint: "[list|get|enable|disable|set|unset|add|remove] [--local]",
		argumentValues: ["list", "get", "enable", "disable", "set", "unset", "add", "remove"],
	},
	{
		name: "model",
		description: "Pick a model for this chat or as the default",
		argumentHint: "[provider/model] [--set-default]",
	},
	{ name: "models", description: "Turn models on or off per provider" },
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
	{
		name: "usage",
		requiresNative: true,
		description: "Show spend by provider and model",
		argumentHint: "[today|7d|30d]",
		argumentValues: ["today", "7d", "30d"],
	},
	{ name: "changelog", description: "Show what's new" },
	{ name: "keys", description: "Show keyboard shortcuts" },
	{ name: "find", description: "Search the transcript (fullscreen mode)" },
	{
		name: "mouse",
		description: "Give the mouse to the terminal, or take it back",
		argumentHint: "[on|off]",
		argumentValues: ["on", "off"],
	},
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
		argumentHint: "[provider|pi|runner:<id>]",
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
		menuAliasOf: "new",
	},
	{
		name: "reset",
		description: "Start a new session (same as /new)",
		argumentHint: "[name-for-current-session]",
		menuAliasOf: "new",
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
	"usage",
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
	"settings",
	"modelsettings",
	"harness",
	"mcp",
	"trust",
	"keys",
	"find",
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
 * Names Claude Code (and Pi: `/hotkeys`) users type from habit, each run as the Octocode command it maps to. The `/` menu
 * shows only the target; `/clear` and `/reset` stay separate hidden entries of `/new`.
 */
export const COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([
	["exit", "quit"],
	["config", "settings"],
	["configuration", "settings"],
	["release-notes", "changelog"],
	["feedback", "bug"],
	["login", "providers"],
	["continue", "resume"],
	["allowed-tools", "permissions"],
	["doctor", "debug"],
	["checkpoint", "rewind"],
	["todos", "backlog"],
	["bashes", "processes"],
	["plugins", "harness"],
	["hooks", "harness"],
	["cost", "usage"],
	["hotkeys", "keys"],
]);

/** Words an alias puts before the typed arguments: `/hooks events` runs `/harness hooks events`. */
const ALIAS_LEADING_ARGS: ReadonlyMap<string, string> = new Map([["hooks", "hooks"]]);

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

/** `/mcp enable|disable <server>` as the `/settings` line that replaced it; the old `-l` flag becomes `--local`. */
function movedMcpSwitch(args: string): string | undefined {
	const [action, server, ...flags] = args.trim().split(/\s+/);
	if ((action !== "enable" && action !== "disable") || !server) return undefined;
	const local = flags.some((flag) => flag === "--local" || flag === "-l");
	return `${action} mcp:${server}${local ? " --local" : ""}`;
}

/** The command a typed line runs, with its arguments: aliases and retired forms resolve to their replacement here, once. */
export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return undefined;
	const [, typed, rest = ""] = match;
	const moved = typed === "mcp" ? movedMcpSwitch(rest) : undefined;
	if (moved) return { name: "settings", args: moved };
	const leading = ALIAS_LEADING_ARGS.get(typed);
	return {
		name: COMMAND_ALIASES.get(typed) ?? typed,
		args: leading ? `${leading} ${rest}`.trim() : rest,
	};
}
