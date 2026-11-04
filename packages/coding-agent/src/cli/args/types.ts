import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import type { TuiMode } from "../../core/settings-manager.ts";

export type Mode = "text" | "json" | "rpc" | "acp";

export interface Args {
	provider?: string;
	model?: string;
	apiKey?: string;
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
	noTools?: boolean;
	noBuiltinTools?: boolean;
	/** Removed flags the command line used (`-e`, `--extension`, `--no-extensions`); the run exits with status 2. */
	removedFlags?: string[];
	noMcp?: boolean;
	print?: boolean;
	/** `--no-stdin`: never read piped stdin, so a pipe the parent leaves open cannot hold the run. */
	noStdin?: boolean;
	/** `--no-dialogs`: nobody answers RPC dialogs, so the session behaves as headless and asks get its refusal. */
	noDialogs?: boolean;
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
	/** `--trust`: record the user's grant for the working folder, then run. */
	trust?: boolean;
	messages: string[];
	fileArgs: string[];
	/** Unknown flags (potentially extension flags) - map of flag name to value */
	unknownFlags: Map<string, boolean | string>;
	/** Words unknown flags consumed as values, returned to `messages` if the flag is boolean. */
	unknownFlagWords?: Array<{ flag: string; word: string; at: number }>;
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
