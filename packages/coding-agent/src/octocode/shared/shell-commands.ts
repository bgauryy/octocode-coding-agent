/**
 * What a bash parse hands to a domain that may not import the parser: every simple command in a command line, wherever
 * it runs (groups, function bodies, `if`/loop bodies, subshells, `$( )`, backticks, process substitutions, and the
 * scripts of `bash -c`, `eval` and `find -exec`), and the function names the line defines. `permission/shell/commands.ts`
 * builds it; `team/interpreter.ts` reads it. The port is injected (`registerCollab`'s `shellCommands`).
 */
export interface ParsedCommand {
	/** The source text of each word in order: leading assignments, the program, its arguments. Redirections are not words. */
	words: string[];
	/** The value of each word after the shell removes quotes and escapes (`py"thon"3` is `python3`, `$'-c'` is `-c`); undefined when it depends on an expansion or glob. Same indexes as `words`. */
	literals: Array<string | undefined>;
	/** Index in `words` of the program after assignments and wrappers (`sudo -u root`, `uv run`, `npx`); undefined when a wrapper's command cannot be found (an expansion or an unknown option before it, a script string), which also makes the command `opaque`. */
	program?: number;
	/** The source text of each redirection (`> out`, `2>&1`, `<<'EOF'`, `< in`, `<<< x`); a here-document shows its start word only. */
	redirects: string[];
	/** Where its standard input comes from: its own here-document or here-string, else a pipe or an input redirect it sits behind. */
	stdin?: "heredoc" | "pipe" | "file";
	/** Runs code the parse could not read: `bash -c "$X"`, `eval $X`, a shell reading its script from stdin, a nested script too deep, a wrapper whose command cannot be found (`timeout $T …`), a computed program name (`$X a b`). */
	opaque?: true;
	/** Why the command is opaque when the generic reason does not fit: a reader given a computed word that may become a writing option (`sort $X in`). */
	opaqueBecause?: string;
}

export interface ParsedShell {
	commands: ParsedCommand[];
	/** Names defined as functions (`node() { …; }`, `function node { …; }`), which change what a later command of that name runs. */
	functions: string[];
}

/** Parses a bash command line; undefined when the parser is unavailable or the parse failed (errors, size or time budget). */
export type ShellParse = (command: string) => Promise<ParsedShell | undefined>;
