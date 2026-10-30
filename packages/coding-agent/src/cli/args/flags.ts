import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { getToolListError, type TuiMode } from "../../core/settings-manager.ts";
import { VALID_THINKING_LEVELS } from "../../core/thinking-level.ts";
import type { Args, Mode } from "../args.ts";

/**
 * Every top-level CLI flag, declared once: the parser, `--help` and shell completion all read this table, so a flag
 * cannot be parsed but undocumented, documented but unparsed, or missing from completion.
 */
export interface FlagSpec {
	name: `--${string}`;
	short?: `-${string}`;
	/**
	 * boolean: no value. value: exactly one value. list: one value, repeatable. csv: one comma-separated value.
	 * optional: takes the next word only when it is not a flag or an @file.
	 */
	kind: "boolean" | "value" | "list" | "csv" | "optional";
	/** Value placeholder in help, e.g. `<name>`. */
	arg?: string;
	/** Allowed values; anything else is an error naming them. */
	values?: readonly string[];
	/** Noun for an invalid value (`Invalid <label> "x"`). */
	label?: string;
	/** Message when the value is missing, when the generic one is not enough. */
	missing?: string;
	completion?: "path" | "text";
	/** First line, then continuation lines. */
	help: readonly string[];
	/** Store the flag; returns why the value is not acceptable (the parser prefixes the flag as typed). */
	apply(args: Args, value: string | undefined): string | undefined;
}

const csv = (value: string) =>
	value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
const push = (list: string[] | undefined, value: string) => [...(list ?? []), value];
const set = (apply: (args: Args) => void) => (args: Args) => {
	apply(args);
	return undefined;
};

export const FLAG_SPECS: readonly FlagSpec[] = [
	{
		name: "--provider",
		kind: "value",
		arg: "<name>",
		completion: "text",
		help: ["Provider to search for --model (requires --model)"],
		apply: (a, v) => void (a.provider = v),
	},
	{
		name: "--model",
		kind: "value",
		arg: "<pattern>",
		completion: "text",
		help: ['Model pattern or ID (supports "provider/id" and optional ":<thinking>")'],
		apply: (a, v) => void (a.model = v),
	},
	{
		name: "--api-key",
		kind: "value",
		arg: "<key>",
		completion: "text",
		help: ["API key (prefer env vars or auth.json: a key on the command line shows up in ps and shell history)"],
		apply: (a, v) => void (a.apiKey = v),
	},
	{
		name: "--system-prompt",
		kind: "value",
		arg: "<text>",
		completion: "text",
		help: ["System prompt (default: coding assistant prompt)"],
		apply: (a, v) => void (a.systemPrompt = v),
	},
	{
		name: "--append-system-prompt",
		kind: "list",
		arg: "<text>",
		completion: "text",
		help: ["Append text or file contents to the system prompt (can be used multiple times)"],
		apply: (a, v) => void (a.appendSystemPrompt = push(a.appendSystemPrompt, v!)),
	},
	{
		name: "--mode",
		kind: "value",
		arg: "<mode>",
		values: ["text", "json", "rpc", "acp"],
		label: "mode",
		help: ["Output mode: text (default), json, rpc, or acp"],
		apply: (a, v) => void (a.mode = v as Mode),
	},
	{
		name: "--print",
		short: "-p",
		kind: "optional",
		help: ["Non-interactive mode: process prompt and exit"],
		apply: set((a) => (a.print = true)),
	},
	{
		name: "--continue",
		short: "-c",
		kind: "boolean",
		help: ["Continue previous session"],
		apply: set((a) => (a.continue = true)),
	},
	{
		name: "--resume",
		short: "-r",
		kind: "boolean",
		help: ["Select a session to resume"],
		apply: set((a) => (a.resume = true)),
	},
	{
		name: "--session",
		kind: "value",
		arg: "<path|id>",
		completion: "path",
		help: ["Use specific session file or partial UUID"],
		apply: (a, v) => void (a.session = v),
	},
	{
		name: "--session-id",
		kind: "value",
		arg: "<id>",
		completion: "text",
		help: ["Use exact project session ID, creating it if missing"],
		apply: (a, v) => void (a.sessionId = v),
	},
	{
		name: "--fork",
		kind: "value",
		arg: "<path|id>",
		completion: "path",
		help: ["Fork specific session file or partial UUID into a new session"],
		apply: (a, v) => void (a.fork = v),
	},
	{
		name: "--session-dir",
		kind: "value",
		arg: "<dir>",
		completion: "path",
		help: ["Directory for session storage and lookup"],
		apply: (a, v) => void (a.sessionDir = v),
	},
	{
		name: "--no-session",
		kind: "boolean",
		help: ["Don't save session (ephemeral)"],
		apply: set((a) => (a.noSession = true)),
	},
	{
		name: "--name",
		short: "-n",
		kind: "value",
		arg: "<name>",
		completion: "text",
		help: ["Set session display name"],
		apply: (a, v) => void (a.name = v),
	},
	{
		name: "--models",
		kind: "csv",
		arg: "<patterns>",
		completion: "text",
		help: [
			"Comma-separated model patterns for Ctrl+P cycling",
			"Supports globs (anthropic/*, *sonnet*) and fuzzy matching",
		],
		apply: (a, v) => void (a.models = csv(v!)),
	},
	{
		name: "--no-tools",
		short: "-nt",
		kind: "boolean",
		help: ["Disable all tools by default (built-in and extension)"],
		apply: set((a) => (a.noTools = true)),
	},
	{
		name: "--no-builtin-tools",
		short: "-nbt",
		kind: "boolean",
		help: ["Disable built-in tools by default but keep extension/custom tools enabled"],
		apply: set((a) => (a.noBuiltinTools = true)),
	},
	{
		name: "--tools",
		short: "-t",
		kind: "csv",
		arg: "<tools>",
		help: [
			"Comma-separated allowlist of tool names or patterns (*) to enable",
			"Keeps MCP tools unless an entry starts with mcp__",
			"Only +name/-name entries add to or remove from the defaults",
		],
		apply: (a, v) => {
			const tools = csv(v!);
			const error = getToolListError(tools);
			if (error) return error;
			a.tools = tools;
			return undefined;
		},
	},
	{
		name: "--exclude-tools",
		short: "-xt",
		kind: "csv",
		arg: "<tools>",
		help: [
			"Comma-separated denylist of tool names or patterns (*) to disable",
			"Applies to all tools, MCP tools included",
		],
		apply: (a, v) => void (a.excludeTools = csv(v!)),
	},
	{
		name: "--thinking",
		kind: "value",
		arg: "<level>",
		values: VALID_THINKING_LEVELS,
		label: "thinking level",
		help: [`Set thinking level: ${VALID_THINKING_LEVELS.join(", ")}`],
		apply: (a, v) => void (a.thinking = v as ThinkingLevel),
	},
	{
		name: "--extension",
		short: "-e",
		kind: "list",
		arg: "<path>",
		completion: "path",
		help: ["Load an extension file or builtin:<name> (can be used multiple times)"],
		apply: (a, v) => void (a.extensions = push(a.extensions, v!)),
	},
	{
		name: "--no-extensions",
		short: "-ne",
		kind: "boolean",
		help: ["Disable extension discovery and built-in extensions (explicit -e paths still work)"],
		apply: set((a) => (a.noExtensions = true)),
	},
	{
		name: "--no-mcp",
		kind: "boolean",
		help: ["Disable built-in MCP support: no servers connect and no MCP tools"],
		apply: set((a) => (a.noMcp = true)),
	},
	{
		name: "--skill",
		kind: "list",
		arg: "<path>",
		completion: "path",
		help: ["Load a skill file or directory (can be used multiple times)"],
		apply: (a, v) => void (a.skills = push(a.skills, v!)),
	},
	{
		name: "--no-skills",
		short: "-ns",
		kind: "boolean",
		help: ["Disable skills discovery and loading"],
		apply: set((a) => (a.noSkills = true)),
	},
	{
		name: "--prompt-template",
		kind: "list",
		arg: "<path>",
		completion: "path",
		help: ["Load a prompt template file or directory (can be used multiple times)"],
		apply: (a, v) => void (a.promptTemplates = push(a.promptTemplates, v!)),
	},
	{
		name: "--no-prompt-templates",
		short: "-np",
		kind: "boolean",
		help: ["Disable prompt template discovery and loading"],
		apply: set((a) => (a.noPromptTemplates = true)),
	},
	{
		name: "--theme",
		kind: "list",
		arg: "<path>",
		completion: "path",
		help: ["Load a theme file or directory (can be used multiple times)"],
		apply: (a, v) => void (a.themes = push(a.themes, v!)),
	},
	{
		name: "--use-theme",
		kind: "value",
		arg: "<name[/name]>",
		completion: "text",
		missing: "--use-theme requires a theme name",
		help: ["Set the initial interactive theme for this run"],
		apply: (a, v) => void (a.useTheme = v),
	},
	{
		name: "--no-themes",
		kind: "boolean",
		help: ["Disable theme discovery and loading"],
		apply: set((a) => (a.noThemes = true)),
	},
	{
		name: "--no-context-files",
		short: "-nc",
		kind: "boolean",
		help: ["Disable AGENTS.md and CLAUDE.md discovery and loading"],
		apply: set((a) => (a.noContextFiles = true)),
	},
	{
		name: "--export",
		kind: "value",
		arg: "<file>",
		completion: "path",
		help: ["Export session file to HTML and exit"],
		apply: (a, v) => void (a.export = v),
	},
	{
		name: "--list-models",
		kind: "optional",
		arg: "[search]",
		completion: "text",
		help: ["List available models (with optional fuzzy search)"],
		apply: (a, v) => void (a.listModels = v ?? true),
	},
	{
		name: "--verbose",
		kind: "boolean",
		help: ["Force verbose startup (overrides quietStartup setting)"],
		apply: set((a) => (a.verbose = true)),
	},
	{
		name: "--tui-mode",
		kind: "value",
		arg: "<mode>",
		values: ["fullscreen", "regular"],
		label: "TUI mode",
		help: ["TUI mode: fullscreen (default) or regular"],
		apply: (a, v) => void (a.tuiMode = v as TuiMode),
	},
	{
		name: "--approve",
		short: "-a",
		kind: "boolean",
		help: ["Trust project-local files for this run"],
		apply: set((a) => (a.projectTrustOverride = true)),
	},
	{
		name: "--no-approve",
		short: "-na",
		kind: "boolean",
		help: ["Ignore project-local files for this run"],
		apply: set((a) => (a.projectTrustOverride = false)),
	},
	{
		name: "--offline",
		kind: "boolean",
		help: ["Disable startup network operations (same as OCTOCODE_OFFLINE=1)"],
		apply: set((a) => (a.offline = true)),
	},
	{ name: "--help", short: "-h", kind: "boolean", help: ["Show this help"], apply: set((a) => (a.help = true)) },
	{
		name: "--version",
		short: "-v",
		kind: "boolean",
		help: ["Show version number"],
		apply: set((a) => (a.version = true)),
	},
];

const BY_NAME = new Map(
	FLAG_SPECS.flatMap((spec) => [[spec.name, spec] as const, ...(spec.short ? [[spec.short, spec] as const] : [])]),
);

export const flagSpec = (arg: string): FlagSpec | undefined => BY_NAME.get(arg as `--${string}`);

/** "a", "a or b", "a, b, or c". */
const either = (values: readonly string[]) =>
	values.length < 3 ? values.join(" or ") : `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;

/** The error for a flag given without its value. */
export const missingValue = (spec: FlagSpec): string =>
	spec.missing ?? (spec.values ? `${spec.name} requires ${either(spec.values)}` : `${spec.name} requires a value`);

/** The error for a value outside `spec.values`, or undefined. */
export const invalidValue = (spec: FlagSpec, value: string): string | undefined =>
	spec.values && !spec.values.includes(value)
		? `Invalid ${spec.label ?? spec.name.slice(2)} "${value}". Valid values: ${spec.values.join(", ")}`
		: undefined;

/** A word that cannot be a flag's value: another flag. A lone dash or text such as "- be brief" still can. */
export const looksLikeFlag = (word: string): boolean => word.startsWith("--") || flagSpec(word) !== undefined;

/** The Options section of `--help`, one row per flag in table order. */
export function flagHelpRows(): string[] {
	return FLAG_SPECS.flatMap((spec) => {
		const head = `  ${spec.name}${spec.short ? `, ${spec.short}` : ""}${spec.arg ? ` ${spec.arg}` : ""}`;
		const [first, ...rest] = spec.help;
		return [`${head.padEnd(33)}${first}`, ...rest.map((line) => `${" ".repeat(33)}${line}`)];
	});
}
