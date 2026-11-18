import type { Node } from "web-tree-sitter";
import { hiddenVariableTest, numericValue } from "./arithmetic.ts";
import { gitVariable, programSetting } from "./git-programs.ts";

/**
 * Variables a line may set without changing which program a later command runs or what it loads. A variable reaches
 * other programs when it is exported: given with `export`, set in front of a command (`X=1 cmd`), or already in the
 * environment the shell inherited, where a plain `X=…;` changes the exported value. So `PATH=/tmp/x; cat f` runs
 * `/tmp/x/cat`. Refused: the variables the shell itself reads (`SHELL_VARIABLES`), names programs read to find code,
 * libraries or configuration (`PROGRAM_FACING`), and any name already in the environment, unless the name is data (a
 * locale, time zone or output format) or holds a number and names no place (`PATH=5` searches `./5`). Every other name
 * (`f=a.ts`, `D=/tmp/out`) is the line's own value. git's variables are judged by `programSetting`.
 */
const DATA_VARIABLES = new Set([
	"LANG",
	"LANGUAGE",
	"TZ",
	"COLUMNS",
	"LINES",
	"TERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"CLICOLOR",
	"CLICOLOR_FORCE",
]);
const LOCALE = /^LC_[A-Z]+$/;
/** Variables bash reads while it runs a line (bash manual, "Shell Variables"), and the programs it starts by name. */
const SHELL_VARIABLES = new Set([
	"PATH",
	"IFS",
	"HOME",
	"CDPATH",
	"BASH_ENV",
	"ENV",
	"SHELL",
	"SHELLOPTS",
	"BASHOPTS",
	"GLOBIGNORE",
	"EXECIGNORE",
	"PS4",
	"BASH_XTRACEFD",
	"BASH_COMPAT",
	"POSIXLY_CORRECT",
	"PROMPT_COMMAND",
	"TMPDIR",
	"PWD",
	"OLDPWD",
	"BROWSER",
	"LESSOPEN",
	"LESSCLOSE",
	"PYTHONSTARTUP",
]);
/** Names programs read to find code, libraries, options or configuration (`LD_PRELOAD`, `NODE_OPTIONS`, `PYTHONPATH`, `RIPGREP_CONFIG_PATH`). */
const PROGRAM_FACING =
	/PATH$|HOME$|DIR$|OPTIONS$|OPTS?$|LIB$|CONFIG|STARTUP|^(?:LD|DYLD|XDG|NODE|NPM|YARN|PYTHON|PERL5?|RUBY|JAVA|BUN|DENO|CARGO|RUST|GO|BASH|ZSH|SSH|GPG)_/;
/** Names whose value is a place to load from or a separator even when it is a number. */
const LOCATION = /PATH$|DIR$|^(?:HOME|BASH_ENV|ENV|PWD|OLDPWD|IFS)$|^(?:LD|DYLD|XDG)_/;
const ASSIGNMENT = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?\+?=/;
const DIGITS = /^[^=]*=\d+$/;
/** Declaration options that export a variable (`-x`) or alias another one (`-n r=PATH`). */
const EXPORTS = /^-[a-zA-Z]*x/;
const ALIASES = /^-[a-zA-Z]*n/;

const dataName = (name: string): boolean => DATA_VARIABLES.has(name) || LOCALE.test(name);

/** Whether setting `name` may reach the shell's own reading or another program: see the comment above. */
const programFacing = (name: string, env: NodeJS.ProcessEnv): boolean =>
	!dataName(name) && (SHELL_VARIABLES.has(name) || PROGRAM_FACING.test(name) || Object.hasOwn(env, name));

const reaches = (name: string): string =>
	`\`${name}\` is a variable the shell or the programs after it read (\`PATH\`, \`HOME\`, \`LD_PRELOAD\`, \`IFS\`, or one already exported), so setting it may make a later command run another program; name a value of your own that is not in the environment`;

/**
 * Why the assignment `text` (`NAME=value`, `NAME+=value`, as written or as `env` reads it) may change what a later
 * command runs; `numeric` when the value is a number (by default: digits as written); `env`, the inherited environment.
 */
export function settingRisk(
	text: string,
	numeric = DIGITS.test(text),
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const name = ASSIGNMENT.exec(text)?.[1];
	if (name === undefined) return undefined;
	if (gitVariable(name)) return programSetting(text);
	if (!programFacing(name, env) || (numeric && !LOCATION.test(name))) return undefined;
	return reaches(name);
}

/** An exported variable reaches every program after it, whatever its name: only data and git's harmless values pass. */
function exportRisk(name: string, text: string): string | undefined {
	if (gitVariable(name)) return programSetting(text);
	return dataName(name) ? undefined : `\`export ${text}\` hands the variable to every program after it`;
}

/** `export`, `declare`, `typeset`, `local`, `readonly`: exporting or aliasing reaches other programs; plain values follow `settingRisk`. */
function declarationRisk(node: Node): string | undefined {
	const keyword = node.child(0)?.text ?? "";
	let exported = keyword === "export";
	for (const child of node.namedChildren) {
		if (!child) continue;
		if (child.type === "word" && child.text.startsWith("-")) {
			if (ALIASES.test(child.text)) return `\`${keyword} ${child.text}\` makes a name stand for another variable`;
			exported ||= EXPORTS.test(child.text);
			continue;
		}
		const name =
			child.type === "variable_assignment"
				? child.childForFieldName("name")?.text
				: child.type === "variable_name"
					? child.text
					: undefined;
		if (name === undefined) return `\`${keyword} ${child.text}\` takes a word the line does not spell out`;
		// Without export the value is read as an assignment by `environmentChange`.
		const because = exported ? exportRisk(name, child.text) : undefined;
		if (because !== undefined) return because;
	}
	return undefined;
}

/** `unset NAME` of a variable the shell or a program reads: an unset `PATH` falls back to bash's default search path, which ends in `.`. */
function unsetRisk(node: Node, env: NodeJS.ProcessEnv): string | undefined {
	let functions = false;
	for (const child of node.namedChildren) {
		if (!child) continue;
		if (child.type === "word" && child.text.startsWith("-")) {
			functions = child.text.includes("f");
			continue;
		}
		if (functions) continue;
		const name = /^([A-Za-z_]\w*)(?:\[\d+\])?$/.exec(child.text)?.[1];
		if (name === undefined) return `\`unset ${child.text}\` names a variable or subscript the line does not spell out`;
		if (!gitVariable(name) && programFacing(name, env)) return reaches(name);
	}
	return undefined;
}

/**
 * Why a variable set in `root` may change which program a later command runs or what it loads: an assignment alone, in a
 * declaration, or `unset`; with `prefixes`, also the assignments in front of a command (`PATH=/tmp/x cat f`). Undefined
 * when every variable the line sets is its own, a number, or data (`LC_ALL`, `TZ`, `GIT_PAGER=cat`). Assignments are
 * judged before declarations, so a git variable gets git's reason.
 */
function environmentChange(root: Node, prefixes: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
	for (const node of root.descendantsOfType("variable_assignment")) {
		if (!node || (!prefixes && node.parent?.type === "command")) continue;
		const because = settingRisk(node.text, numericValue(node.childForFieldName("value")), env);
		if (because !== undefined) return because;
	}
	for (const node of root.descendantsOfType(["declaration_command", "unset_command"])) {
		const because = node && (node.type === "declaration_command" ? declarationRisk(node) : unsetRisk(node, env));
		if (because) return because;
	}
	return undefined;
}

/**
 * Why `root` may run a program or code no command of it names: a variable set as `environmentChange` judges it, or a
 * `-v` test of a subscript bash evaluates (`[[ -v 'a[$(cmd)]' ]]` runs `cmd`). The reading every shell check shares:
 * read-only lines, the team parse, and what a command changes.
 */
export function programSwap(root: Node, prefixes: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const test = hiddenVariableTest(root);
	return (
		environmentChange(root, prefixes, env) ??
		(test &&
			`the test \`${test}\` names a variable or subscript the line does not spell out, and bash evaluates a subscript there, command substitution included; test a plain name (\`-v name\`, \`-v a[0]\`)`)
	);
}
