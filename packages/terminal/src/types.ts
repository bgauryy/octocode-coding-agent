/** One completion for the word being typed. */
export interface ShellCompletion {
	/** Text that replaces the word being typed, already quoted for the shell. */
	value: string;
	/** What the list shows. */
	label: string;
	description?: string;
	kind?: "command" | "directory" | "file";
	/** True when accepting it must not add a space after it (a directory, `--option=`). */
	noSpace?: boolean;
}

/** Completions that replace `text.slice(start)` of the completed text. */
export interface ShellCompletions {
	start: number;
	items: ShellCompletion[];
	/** Which source answered: a shell, `path` (PATH programs), `git` (branch names) or `carapace`. */
	source: string;
}

/** Shells Octocode can ask for completions. */
export type ShellName = "zsh" | "bash" | "fish" | "pwsh";

/** The `shell` setting: one shell, `auto` (the user's login shell) or `none` (no shell is started). */
export type ShellSetting = ShellName | "auto" | "none";

/** How the completion shell starts. */
export interface ShellCompletionOptions {
	shell: ShellSetting;
	/** Source the user's own startup files (`.zshrc`, `.bashrc`, `config.fish`, the PowerShell profile). */
	loadRc: boolean;
	/** Ask `carapace`, when it is on PATH, for commands the shell has no completion for. */
	carapace: boolean;
}

/** A raw match a shell driver printed: `value`, `description` and flags (`q` already quoted, `d` directory, `@N` start). */
export interface DriverMatch {
	value: string;
	description: string;
	flags: string;
}
