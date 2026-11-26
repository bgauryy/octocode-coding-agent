import type { Node } from "web-tree-sitter";
import type { ParsedCommand, ParsedShell } from "../../shared/shell-commands.ts";
import { misreadHerestring } from "../bash-herestring.ts";
import { initializeBashSyntax, parseBash, staticWord, translatedString } from "../bash-syntax.ts";
import { literalVariables, resolvedWord } from "../bash-variables.ts";
import { hiddenArithmetic } from "./arithmetic.ts";
import { unrollLoops } from "./loops.ts";
import { programSwap, settingRisk } from "./environment.ts";
import { gitProgram } from "./git-programs.ts";
import { runInput } from "./input-runners.ts";
import { computedOption, inputMayWrite } from "./read-only.ts";
import { SHELLS, base, splitString, wrappedCommand } from "./words.ts";

/**
 * Every simple command of a bash command line as a parse finds it, for a domain that may not import the parser
 * (`registerCollab`'s `shellCommands` port, wired by `index.ts`; the contract is `shared/shell-commands.ts`). Commands inside
 * `{ …; }` groups, function bodies, `if`/`while`/`for`/`case` bodies, subshells, `$( )`, backticks and process substitutions
 * are all `command` nodes, so one walk finds them. The code a command passes on is read too: the script of `bash -c`,
 * `eval` and `trap`, and the command after `find -exec`, each parsed again up to `MAX_NESTING` deep. Code that cannot be
 * read (`bash -c "$X"`, `eval $X`, a shell fed its script on stdin, `source <(…)`, a computed program name `$X a b`)
 * comes back `opaque`.
 */

const MAX_NESTING = 4;
const MAX_COMMANDS = 2048;
const SHELL_CODE_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
const STDIN_SOURCE = /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+)$/;
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

type Stdin = NonNullable<ParsedCommand["stdin"]>;

const isRedirect = (node: Node): boolean => node.type.endsWith("_redirect");

/** The words a redirection holds after its destination: the grammar reads `python3 >out -c x` as a redirect with three words. */
function trailingWords(redirect: Node): Node[] {
	if (redirect.type !== "file_redirect" && redirect.type !== "herestring_redirect") return [];
	return redirect.namedChildren
		.filter((child): child is Node => child !== null && child.type !== "file_descriptor" && child.type !== "comment")
		.slice(1);
}

/**
 * The digits-only word that directly abuts a redirection (`python3 0<f`, `cat a 0< f`) and so is its descriptor. The grammar
 * reads it as a word of the command, or of the redirection before it, unless it is `NN>` after a space-less operator.
 */
function descriptorWord(redirect: Node): Node | undefined {
	if (redirect.startIndex === 0 || redirect.children.some((child) => child?.type === "file_descriptor"))
		return undefined;
	const word = redirect.tree.rootNode.descendantForIndex(redirect.startIndex - 1);
	if (!word || word.endIndex !== redirect.startIndex || !/^\d+$/.test(word.text)) return undefined;
	// `A=1<f` and `"x"0<f` are one word with the digit in it.
	return ["command", "command_name", "file_redirect", "herestring_redirect"].includes(word.parent?.type ?? "")
		? word
		: undefined;
}

/** A redirection that replaces standard input: `<`, `<<`, `<<<`, `<&` or `<>` on descriptor 0 (or none). */
function feedsStdin(redirect: Node): boolean {
	const descriptor =
		redirect.children.find((child) => child?.type === "file_descriptor")?.text ?? descriptorWord(redirect)?.text;
	if (descriptor !== undefined && Number(descriptor) !== 0) return false;
	if (redirect.type !== "file_redirect" || misreadHerestring(redirect)) return true;
	return (redirect.children.find((child) => child && !child.isNamed)?.text ?? "").startsWith("<");
}

/** The source text of a redirection; a here-document shows its start word, not the body (which can hold anything). */
function redirectText(redirect: Node): string {
	const start = redirect.children.find((child) => child?.type === "heredoc_start");
	const destination = redirect.namedChildren.find((child) => child?.type !== "file_descriptor");
	const end = start ?? (trailingWords(redirect).length > 0 ? destination : undefined);
	const text = end ? redirect.text.slice(0, end.endIndex - redirect.startIndex) : redirect.text;
	// A here-string the grammar split into `<<` and `< word` (`cat > f <<< hi`) is shown as written.
	const split = misreadHerestring(redirect) && !redirect.text.includes("<<<") ? "<<" : "";
	return (descriptorWord(redirect)?.text ?? "") + split + text;
}

/** The redirections that apply to `command` itself: its own, and those of the statement that wraps it. */
function redirectsOf(command: Node): Node[] {
	const own = command.namedChildren.filter((child): child is Node => child !== null && isRedirect(child));
	const wrapper = command.parent;
	if (wrapper?.type !== "redirected_statement" || wrapper.childForFieldName("body")?.id !== command.id) return own;
	return [...own, ...wrapper.namedChildren.filter((child): child is Node => child !== null && isRedirect(child))];
}

/** Standard input the command's own redirections give it: a here-document or here-string, or a file. */
function ownStdin(command: Node): Stdin | undefined {
	const own = redirectsOf(command).filter(feedsStdin);
	return own.some((redirect) => redirect.type !== "file_redirect" || misreadHerestring(redirect))
		? "heredoc"
		: own.length > 0
			? "file"
			: undefined;
}

/** Where standard input comes from: the command's own here-document or here-string, else a pipe or an input redirect around it. */
function stdinOf(command: Node, stages: Map<number, Set<number>>): Stdin | undefined {
	let found = ownStdin(command);
	if (found === "heredoc") return found;
	for (let node = command, up = node.parent; up; node = up, up = up.parent) {
		if (up.type === "pipeline") {
			// A `|` before a stage feeds it (also when a here-document opens the pipeline and the first stage is bare). Found once per pipeline.
			let fed = stages.get(up.id);
			if (!fed) {
				fed = new Set();
				let piped = false;
				for (const child of up.children) {
					if (!child) continue;
					if (child.isNamed) {
						if (piped) fed.add(child.id);
					} else if (child.type.startsWith("|")) piped = true;
				}
				stages.set(up.id, fed);
			}
			if (fed.has(node.id)) return "pipe";
		} else if (up.type === "redirected_statement" && up.childForFieldName("body")?.id === node.id) {
			if (up.namedChildren.some((child) => child !== null && isRedirect(child) && feedsStdin(child))) found ??= "file";
		}
	}
	return found;
}

/**
 * The words of a command node in order: its assignments, its name and its arguments, including those the grammar put
 * inside a redirection, and not a digits-only word that is a redirection's descriptor.
 */
function wordsOf(command: Node): Node[] {
	const redirects = redirectsOf(command);
	const descriptors = new Set(redirects.map((redirect) => descriptorWord(redirect)?.startIndex));
	return [
		...command.namedChildren.filter(
			(child): child is Node => child !== null && !isRedirect(child) && child.type !== "comment",
		),
		...redirects.flatMap(trailingWords),
	]
		.filter((word) => !descriptors.has(word.startIndex))
		.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Words that sit between a command and its here-document in the source but in no node: the grammar drops a lone `-`
 * there (`node a - <<'EOF'` parses as `node a`), and `-` is how `node` and `python` read their code from the document.
 */
function droppedWords(command: Node): string[] {
	// The document binds to the last command of the statement it follows (`cd src && node - <<EOF`).
	for (let node = command; node.parent; node = node.parent) {
		const wrapper = node.parent;
		if (wrapper.type === "redirected_statement" && wrapper.childForFieldName("body")?.id === node.id) {
			const redirect = wrapper.namedChildren.find((child) => child !== null && isRedirect(child));
			if (!redirect) return [];
			const gap = wrapper.text.slice(node.endIndex - wrapper.startIndex, redirect.startIndex - wrapper.startIndex);
			return gap.split(/\s+/).filter(Boolean);
		}
		if (wrapper.endIndex !== node.endIndex) return [];
	}
	return [];
}

/** A word's value as the shell reads it: `staticWord` plus a plain `$'…'` string; none for a `$"…"` (`translatedString`). */
function literalOf(node: Node): string | undefined {
	const inner = node.type === "command_name" && node.namedChildCount === 1 ? node.namedChild(0)! : node;
	return inner.type === "ansi_c_string" && !inner.text.includes("\\") ? inner.text.slice(2, -1) : staticWord(node);
}

/** A word's source text with line continuations removed, as the shell reads it; a `$"…"` keeps its `$`, which the grammar holds outside the string. */
const raw = (node: Node): string => (translatedString(node) ? "$" : "") + node.text.replace(/\\\r?\n/g, "");

/** Why a reader given `word`, which the line does not spell out, is opaque (`computedOption`). */
const computedBecause = (name: string, word: string): string =>
	name === "uniq"
		? `\`uniq\` is given \`${word}\`, a word the line does not spell out, which may name its output file`
		: `\`${name}\` is given \`${word}\`, a word the line does not spell out, which may expand to an option that writes or runs a program; start it with a literal character (\`./"$F"\`)${name === "find" ? "" : " or put `--` before it"}`;

interface Collected extends ParsedShell {
	count: number;
}

/** Adds one command and, from what it runs, the commands in the code it passes on. */
function add(
	out: Collected,
	words: string[],
	literals: Array<string | undefined>,
	first: number,
	redirects: string[],
	stdin: Stdin | undefined,
	depth: number,
): void {
	const real = wrappedCommand(literals, first);
	const entry: ParsedCommand = {
		words,
		literals,
		...(real !== undefined && real < literals.length ? { program: real } : {}),
		redirects,
		...(stdin ? { stdin } : {}),
	};
	out.commands.push(entry);
	out.count++;
	/** Marks the entry opaque because it runs a program the line names (`git-programs.ts`), keeping the first reason. */
	const runsProgram = (because: string | undefined): void => {
		if (because === undefined) return;
		entry.opaque = true;
		entry.opaqueBecause ??= because;
	};
	// A variable set in front (`PATH=/tmp/x cat`, `GIT_SSH_COMMAND=… git fetch`, `env GIT_PAGER=… make`) that swaps the program run.
	const runs = real === undefined ? undefined : literals[real];
	const runsName = runs === undefined ? undefined : base(runs);
	for (let at = 0; at < (real ?? literals.length); at++)
		runsProgram(settingRisk(literals[at] ?? words[at] ?? "", undefined, undefined, runsName));
	const nest = (script: string | undefined): void => {
		if (script === undefined || depth >= MAX_NESTING) {
			entry.opaque = true;
			return;
		}
		const inner = collect(script, depth + 1);
		if (!inner) {
			entry.opaque = true;
			return;
		}
		for (const command of inner.commands) out.commands.push({ ...command, stdin: command.stdin ?? stdin });
		out.functions.push(...inner.functions);
	};
	if (real === undefined) {
		// `env -S` splits its string into the command and its arguments; the words after it are appended. env expands `${VAR}` and reads `\_`, `\c`, so a string using them is not read here.
		const split = splitString(literals, first);
		// Otherwise the wrapper's command is hidden (`timeout $T python3 -c …`, an option the table does not know, `watch '…'`):
		// whatever it runs cannot be read.
		nest(
			!split || split.value === undefined || /\\|\$\{/.test(split.value)
				? undefined
				: `${split.value} ${words.slice(split.end).join(" ")}`,
		);
		return;
	}
	// Behind `xargs` or `parallel`, words read at run time may name the program, or give one judged by its words an operand
	// or option that writes (`xargs find` given `-delete`): what it runs cannot be read.
	const input = runInput(literals, first, real);
	if (input?.programFromInput) {
		entry.opaque = true;
		return;
	}
	// A bare wrapper (`exec 0<file`) runs nothing.
	if (real >= literals.length) return;
	const program = literals[real];
	// A computed program name (`$X a b`, `$(…) a b`) hides which program runs: whatever it runs cannot be read.
	if (program === undefined) {
		entry.opaque = true;
		return;
	}
	const name = base(program);
	const args = literals.slice(real + 1);
	if (input && inputMayWrite(name, args, input)) entry.opaque = true;
	// A reader with a writing option given a word the line does not spell out (`sort $X in`) may be given that option.
	const computed = computedOption(name, args, words.slice(real + 1));
	if (computed !== undefined) {
		entry.opaque = true;
		entry.opaqueBecause = computedBecause(name, computed);
	}
	if (name === "git") runsProgram(gitProgram(args, words.slice(real + 1)));
	if (SHELLS.has(name)) {
		// The script is the first operand once the options are read (`-o pipefail`, `--`); `-s` reads it from stdin whatever follows.
		const operands: Array<string | undefined> = [];
		const options: Array<string | undefined> = [];
		for (let at = 0; at < args.length; at++) {
			const word = args[at];
			if (word === "--") {
				operands.push(...args.slice(at + 1));
				break;
			}
			if (word !== undefined && /^[-+][oO]$/.test(word)) at++;
			(word === undefined || !word.startsWith("-") ? operands : options).push(word);
		}
		const codeFlag = options.some((word) => word !== undefined && SHELL_CODE_FLAG.test(word));
		if (codeFlag) {
			if (operands.length > 0) nest(operands[0]);
			else entry.opaque = true;
		}
		// Without `-c` a shell runs a script file, or reads its script from standard input.
		else if (stdin && (operands.length === 0 || options.includes("-s"))) entry.opaque = true;
	} else if (name === "eval") nest(args.includes(undefined) ? undefined : args.join(" "));
	else if (name === "trap") {
		const at = args.findIndex((word) => word === undefined || !word.startsWith("-"));
		if (at >= 0) nest(args[at]);
	} else if (name === "source" || name === ".") {
		if (
			args.some((word) => word === undefined || STDIN_SOURCE.test(word)) ||
			words.slice(real + 1).some((word) => word.startsWith("<("))
		)
			entry.opaque = true;
	} else if (name === "find") {
		args.forEach((word, at) => {
			if (word === undefined || !FIND_EXEC.has(word)) return;
			let end = at + 1;
			while (end < args.length && args[end] !== ";" && args[end] !== "+") end++;
			const from = real + 2 + at;
			if (end > at + 1 && depth < MAX_NESTING)
				add(out, words.slice(from, real + 1 + end), literals.slice(from, real + 1 + end), 0, [], undefined, depth + 1);
		});
	}
}

/** Every command and function definition in `root`; undefined when there are too many to walk. */
function walk(root: Node, depth: number): Collected | undefined {
	const commands = root.descendantsOfType("command").filter((node): node is Node => node !== null);
	if (commands.length > MAX_COMMANDS) return undefined;
	const out: Collected = { commands: [], functions: [], count: 0 };
	const stages = new Map<number, Set<number>>();
	// The grammar leaves backticks in an unquoted here-document body as text; the shell runs them.
	for (const redirect of root.descendantsOfType("heredoc_redirect")) {
		if (!redirect || /['"\\]/.test(redirect.children.find((child) => child?.type === "heredoc_start")?.text ?? ""))
			continue;
		const body = redirect.children.find((child) => child?.type === "heredoc_body")?.text ?? "";
		for (const [, script] of body.matchAll(/`([^`]*)`/g)) {
			const inner = depth < MAX_NESTING ? collect(script, depth + 1) : undefined;
			if (inner) out.commands.push(...inner.commands);
			else out.commands.push({ words: ["bash"], literals: ["bash"], program: 0, redirects: [], opaque: true });
			out.functions.push(...(inner?.functions ?? []));
		}
	}
	// Arithmetic on a variable whose value the line does not show evaluates that value as code (`arithmetic.ts`).
	const arithmetic = hiddenArithmetic(root);
	if (arithmetic !== undefined)
		out.commands.push({
			words: [arithmetic],
			literals: [undefined],
			program: 0,
			redirects: [],
			opaque: true,
			hiddenArithmetic: true,
			opaqueBecause: `the arithmetic \`${arithmetic.trim()}\` names a variable whose value the line does not show, and bash evaluates that value as an expression that can run a command; give the variable a number in the line (\`S=0\`, \`S=$(date +%s)\`)`,
		});
	// A bare `exec` with input redirections changes standard input for the rest of the script.
	let inherited: Stdin | undefined;
	const variables = literalVariables(root, staticWord);
	for (const command of commands) {
		const nodes = wordsOf(command);
		const first = nodes.findIndex((node) => node.type !== "variable_assignment");
		if (first < 0) continue;
		const redirects = redirectsOf(command).map(redirectText);
		// Arguments read a variable the line gave a plain literal; the program name does not (`bash-variables.ts`).
		const literals = nodes.map((node) =>
			node.type === "variable_assignment"
				? undefined
				: node.type === "command_name"
					? literalOf(node)
					: resolvedWord(node, variables, literalOf),
		);
		const dropped = droppedWords(command);
		const all = [...literals, ...dropped];
		add(out, [...nodes.map(raw), ...dropped], all, first, redirects, stdinOf(command, stages) ?? inherited, depth);
		if (base(all[first] ?? "") === "exec" && wrappedCommand(all, first) === all.length)
			inherited = ownStdin(command) ?? inherited;
		if (out.count > MAX_COMMANDS) return undefined;
	}
	// A variable set outside a command (`PATH=/tmp/x; cat f`, `export GIT_SSH_COMMAND=…`, `unset PATH`) reaches the commands
	// after it, and `[[ -v 'a[$(cmd)]' ]]` runs what its subscript names (`environment.ts`, `arithmetic.ts`). Listed after
	// the real commands, so an interpreter run keeps its own refusal.
	const because = programSwap(root, false);
	if (because !== undefined)
		// Named `git`, the program it reaches: an entry of assignments only is no command to the team gate.
		out.commands.push({ words: ["git"], literals: [undefined], redirects: [], opaque: true, opaqueBecause: because });
	for (const definition of root.descendantsOfType("function_definition")) {
		const name = definition?.childForFieldName("name")?.text;
		if (name) out.functions.push(name);
	}
	return out;
}

function collect(script: string, depth: number): ParsedShell | undefined {
	return parseBash(script, (root) => walk(root, depth));
}

/** The parsed commands of `command`; undefined when the parser is unavailable or the parse failed (errors, size, time). */
export async function parsedShell(command: string): Promise<ParsedShell | undefined> {
	await initializeBashSyntax().catch(() => undefined);
	const found = collect(unrollLoops(command), 0);
	return found && { commands: found.commands, functions: found.functions };
}
