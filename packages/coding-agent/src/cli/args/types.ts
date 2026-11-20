import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { TuiMode } from "../../core/settings-manager.ts";
import type { PermissionMode } from "../../octocode/permission/mode.ts";

export type Mode = "text" | "json" | "rpc" | "acp";

export interface Args {
	provider?: string;
	model?: string;
	/** The key of `--api-key`, or the value of the variable `--api-key-env` names. */
	apiKey?: string;
	/** The variable `--api-key-env` read `apiKey` from. */
	apiKeyEnv?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	continue?: boolean;
	resume?: boolean;
	help?: boolean;
	version?: boolean;
	mode?: Mode;
	name?: string;
	noSession?: boolean;
	session?: string;
	sessionId?: string;
	fork?: string;
	sessionDir?: string;
	/** Name of the worktree to start in (`--worktree`). */
	worktree?: string;
	models?: string[];
	tools?: string[];
	excludeTools?: string[];
	/** `--enable`, `--disable` and `--set key=value`: configuration for this run only (`configuration/run-flags.ts`). */
	enable?: string[];
	disable?: string[];
	set?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	/** The start mode `--permission-mode` or `--dangerously-skip-permissions` (`bypass`) chose. */
	permissionMode?: PermissionMode;
	noMcp?: boolean;
	/** `--plan`: start with the planning constraint on. */
	plan?: boolean;
	print?: boolean;
	/** `--no-stdin`: never read piped stdin, so a pipe the parent leaves open cannot hold the run. */
	noStdin?: boolean;
	/** `--no-dialogs`: nobody answers RPC dialogs, so the session behaves as headless and asks get its refusal. */
	noDialogs?: boolean;
	/** `--rpc-ask`: the RPC client answers `ask` requests, so the session's UI offers `ask` (batches of typed questions). */
	rpcAsk?: boolean;
	/** `--rpc-lean-events`: the RPC client takes lean events (`modes/json-event-lean.ts`). */
	rpcLeanEvents?: boolean;
	export?: string;
	noSkills?: boolean;
	skills?: string[];
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	useTheme?: string;
	noThemes?: boolean;
	noContextFiles?: boolean;
	listModels?: string | true;
	offline?: boolean;
	tuiMode?: TuiMode;
	verbose?: boolean;
	/** `--no-color`: no ANSI color (the process already runs with `OCTOCODE_NO_COLOR` set). */
	noColor?: boolean;
	/** `--trust`: record the user's grant for the working folder, then run. */
	trust?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Names of the `--flags` the parser does not know; each also has an error in `diagnostics`. */
	unknownFlags: string[];
	diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}

/**
 * Every top-level CLI flag, declared once: the parser, `--help` and shell completion all read this table, so a flag
 * cannot be parsed but undocumented, documented but unparsed, or missing from completion.
 */
export interface FlagSpec {
	/** Parsed so its value is consumed, but left out of help and completion; used by removed flags. */
	hidden?: boolean;
	name: `--${string}`;
	short?: `-${string}`;
	/**
	 * boolean: no value. value: exactly one value. list: one value, repeatable. csv: one comma-separated value.
	 * optional: takes the next word only when it is not a flag or an @file.
	 */
	kind: "boolean" | "value" | "list" | "csv" | "optional";
	/** optional only: when set, the next word is taken as the value only if this accepts it; otherwise it stays a message. */
	takesNext?(word: string): boolean;
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
