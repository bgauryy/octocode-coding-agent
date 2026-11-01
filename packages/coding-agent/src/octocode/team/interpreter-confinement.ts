/**
 * The one inline-interpreter form the reservation gate lets through while another agent holds a reservation: Node under
 * its permission model with writes denied (`confinementFault`). Split from `interpreter.ts`, which finds the runs; this file
 * decides whether a run is confined and, when it is not, says which part of the line broke the form.
 */

/**
 * One interpreter run on inline code: its name and token, the words before the token in its command, and the words
 * after (arguments, then redirections). `opaque` marks code the parse could not read (`bash -c "$X"`) or a function or
 * alias that redefines a program; `confinementFault` never accepts it.
 */
export interface Run {
	name: string;
	program: string;
	before: string[];
	rest: string[];
	opaque?: true;
	/** Why an opaque run is refused, when the parse said (`ParsedCommand.opaqueBecause`). */
	because?: string;
}

/** Stands for a quoted string in the tokenized line; no word the allowlist accepts contains it, so a quoted word is never taken for an option. */
export const QUOTED = "\u0001";
export const QUOTES = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
export const NODE = /^(node|nodejs)$/;

/**
 * Text anywhere in the command that lifts the permission model's limits, or can set them or swap the program from
 * outside the run: any `--allow-*` but `--allow-fs-read` (write, child process, worker, addon, WASI), `--no-permission`,
 * `NODE_OPTIONS` (Node reads it after the command line), files that can supply either, and a changed `PATH` or loader.
 * Matched on the raw text, so a mention inside the code also refuses: refusing when unsure is the rule here.
 * `export` and `alias` are not in it: they lift nothing by themselves (what they set is matched here as text), so they
 * refuse only as shell words (`shellWordLifts`), never inside quoted code or a path.
 */
const LIFTS_PERMISSION =
	/--allow[-_](?!fs[-_]read\b)[\w-]*|--no[-_](?:experimental[-_])?permission|NODE_OPTIONS|BASH_ENV|--env-file|--experimental[-_](?:default[-_])?config[-_]file|\bPATH=|\b(?:DY)?LD_\w+=/;
const SHELL_LIFTERS = new Set(["export", "alias"]);

/**
 * The `export` or `alias` the shell would run, or undefined: a word of its own outside quotes, a whole quoted word that
 * spells it (`'export' X=1`), or a word glued from quoted pieces (`ex''port`). A quoted string that is a whole word is
 * data (Node's code, a path) unless it spells the command itself; a quote inside a word is dropped before the word is read.
 */
function shellWordLifts(command: string): string | undefined {
	const text = command.replace(/\\\r?\n/g, " ");
	const edge = /[\s;&|()]/;
	const bare = text.replace(QUOTES, (quoted, offset: number) => {
		const before = text[offset - 1];
		const after = text[offset + quoted.length];
		if ((before !== undefined && !edge.test(before)) || (after !== undefined && !edge.test(after))) return quoted;
		const inner = quoted.slice(1, -1).trim();
		return SHELL_LIFTERS.has(inner) ? inner : QUOTED;
	});
	return bare
		.replace(/['"\\]/g, "")
		.split(/[\s;&|(){}`]+/)
		.find((word) => SHELL_LIFTERS.has(word));
}

/** Words the shell takes literally: no expansion, quote, escape or glob character, and no `=` (so no assignment or `--opt=value`). */
const LITERAL = /^[A-Za-z0-9_./+:,@%-]+$/;
const READ_OPTION = /^--allow-fs-read=[A-Za-z0-9_./*+:,@%-]+$/;
const NODE_PROGRAM = /^(?:\/(?:[A-Za-z0-9_.+-]+\/)*)?node(?:js)?$/;
/**
 * Wrappers that may precede confined Node, bare or with a duration (`timeout 5`): each runs the same program with the same
 * words and writes nothing itself. Not `xargs` (it appends words, which Node reads as options), `sudo`/`doas` (another
 * environment and `PATH`), or any wrapper option (`time -o file` writes a file).
 */
export const CONFINED_WRAPPERS = new Set(["time", "timeout", "nice", "nohup", "exec", "command", "env"]);
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
/** `node:sqlite` opens and creates database files outside the permission model (checked on Node 26.4), so it must be off. */
const NO_SQLITE = "--no-experimental-sqlite";
const CODE_OPTIONS = new Set(["-e", "-p", "--eval", "--print", "-"]);
/** A word after the code that Node cannot read as an option: it starts with a plain character (or `<` or `>` of a redirect) and holds no expansion or glob. A quoted word starts with `QUOTED`, which may hide a leading dash. */
const POSITIONAL = /^[A-Za-z0-9_./+:,@%<>][^$`\\*?[~{]*$/;

/**
 * The environment can lift the limits before the command line is read: `NODE_OPTIONS` (any value: Node reads it after the
 * command line and an `--allow-fs-write=*` in it wins) and `BASH_ENV` (a file the shell sources first). The bash tool
 * starts every command from `process.env` plus a `PATH` entry (`core/tools/bash.ts` `bashSessionEnv`, `utils/shell.ts`
 * `getShellEnv`), so that is the environment the gate reads. Keys compare in upper case: Windows environments ignore case.
 * No shell outlives a call: each command spawns a new one (`core/tools/bash/local-operations.ts:47` calling `spawnShell`,
 * `utils/shell.ts:207`), so an `export` from an earlier call is gone, and one in the same line is in the text the gate reads.
 * An SDK `spawnHook` (`core/tools/bash.ts:84`) can still change `env` after the gate; that is not covered here.
 */
function environmentLift(env: NodeJS.ProcessEnv): string | undefined {
	return Object.keys(env).find((key) => /^(?:NODE_OPTIONS|BASH_ENV)$/i.test(key.toUpperCase()) && Boolean(env[key]));
}

/** What the shell could expand or run that the tokenizer cannot see: a `$`, a backtick or an escaped single quote outside single quotes. */
function expansionOf(command: string): string | undefined {
	const outside = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) => (quoted.startsWith("'") ? "" : quoted));
	const found = /[$`]/.exec(outside)?.[0] ?? (command.includes("\\'") ? "\\'" : undefined);
	return found === undefined
		? undefined
		: `\`${found}\` outside single quotes (the shell may expand it: quote the code in single quotes and keep \`$\` out of the line)`;
}

const NODE_FORM = "node --permission --no-experimental-sqlite --allow-fs-read=* -e '<code>'";

/**
 * Why this run is not confined, or undefined when it is: Node runs the code under its permission model with filesystem
 * writes, child processes, workers, addons and WASI denied, and `node:sqlite` (which writes outside that model) unavailable,
 * `node --permission --no-experimental-sqlite --allow-fs-read=* -e …`. The runtime then refuses every write the
 * model covers, so the code cannot reach a reserved path by accident; this is the one inline form whose writes are
 * bounded without reading the code. Node calls the model a seat belt for trusted code, not a boundary against
 * malicious code, which fits a gate against accidental writes. It holds only when the line is what it looks like, so
 * the check is an allowlist:
 * - every word before the program is a wrapper from `CONFINED_WRAPPERS` or a duration (never an option, assignment or `$word`);
 * - the program is `node` or an absolute path to it;
 * - every word between the program and the code option is exactly `--permission`, `--no-experimental-sqlite` or
 *   `--allow-fs-read=<literal>`, and the first two both appear;
 * - the code option is `-e`, `-p`, `--eval`, `--print` or `-`, followed by its code word, and the words after that are
 *   plain positional words or a redirect, because Node reads an option there too (`-e code --allow-fs-write=*` writes);
 * - nothing the shell would expand appears outside single quotes, no `export` or `alias` word runs, and the environment sets
 *   neither `NODE_OPTIONS` nor `BASH_ENV`.
 * A quoted word is never an option, so `'--allow-fs-write=*'` or `--al''low-fs-write=*` fails the allowlist.
 * A function or alias that redefines `node` or a wrapper is an opaque run (`parsedRuns`), refused whatever else the line holds.
 * The answer names the first part that broke the form, for the refusal the model reads.
 */
export function confinementFault(run: Run, command: string, env: NodeJS.ProcessEnv): string | undefined {
	if (run.opaque)
		return run.because ?? "it runs a function, alias, `-c` script or computed program name the parse could not read";
	if (!NODE.test(run.name)) return `${run.name} has no read-only form`;
	if (!NODE_PROGRAM.test(run.program)) return `\`${run.program}\` is not plain \`node\` or an absolute path to it`;
	const lifting = LIFTS_PERMISSION.exec(command)?.[0] ?? shellWordLifts(command);
	if (lifting !== undefined) return `\`${lifting}\` appears in the line and could lift the permission limits`;
	const expanding = expansionOf(command);
	if (expanding !== undefined) return expanding;
	const lifted = environmentLift(env);
	if (lifted !== undefined) return `the environment sets ${lifted.toUpperCase()}, which can lift the permission limits`;
	const wrapperOrDuration = (word: string) =>
		CONFINED_WRAPPERS.has(word.slice(word.lastIndexOf("/") + 1)) || DURATION.test(word);
	const stray = run.before.find((word) => !(LITERAL.test(word) && wrapperOrDuration(word)));
	if (stray !== undefined)
		return `\`${stray}\` before node is not a plain wrapper (time, timeout N, nice, nohup, exec, command, env)`;
	let index = 0;
	let permission = false;
	let noSqlite = false;
	for (; index < run.rest.length; index++) {
		const word = run.rest[index];
		if (word === "--permission") permission = true;
		else if (word === NO_SQLITE) noSqlite = true;
		else if (!READ_OPTION.test(word)) break;
	}
	const option = run.rest[index++];
	if (!permission || !noSqlite)
		return `node needs both \`--permission\` and \`${NO_SQLITE}\` before the code (${NODE_FORM})`;
	if (option === undefined) return "no code option (-e or -p) follows the node flags";
	if (!CODE_OPTIONS.has(option))
		return `\`${option}\` between node and its code is not \`--allow-fs-read=<path>\` or a code option (-e, -p)`;
	// `-e` and `-p` take the next word as code; a `-` reads it from stdin, usually a heredoc.
	if (option !== "-") {
		const code = run.rest[index++];
		if (code === undefined || !(LITERAL.test(code) || code.includes(QUOTED)))
			return `the code after \`${option}\` is not one quoted word`;
	}
	const after = run.rest.slice(index).find((word) => !POSITIONAL.test(word));
	return after === undefined ? undefined : `\`${after}\` after the code could be read by node as an option or expand`;
}
