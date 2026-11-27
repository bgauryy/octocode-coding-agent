import { operandsOf, type Word } from "./program-forms.ts";

/** Interpreters whose code can come from the command line or standard input, by the flag that takes it. */
const CODE_FLAGS: ReadonlyMap<string, RegExp> = new Map([
	["python", /^-[a-zA-Z]*c$/],
	["perl", /^-[a-zA-Z]*[eE]$/],
	["ruby", /^-[a-zA-Z]*e$/],
	["node", /^(?:-[pe]{1,2}|--eval|--print)$/],
	["nodejs", /^(?:-[pe]{1,2}|--eval|--print)$/],
	["deno", /^eval$/],
	["php", /^-r$/],
	["lua", /^-e$/],
]);

/** Options that only report (`python3 --version`), so a bare call with them runs no code. */
const INFORMATION = /^(?:-V|-v|-h|--version|--help)$/;

/** `python3.12` and `pypy3` are `python`; the rest keep their name. */
const family = (name: string): string => (/^(?:python|pypy)[\d.]*$/.test(name) ? "python" : name);

/**
 * Whether `name rest` runs code the line carries: a `-c`/`-e` script, or no script file (standard input: a heredoc, a
 * pipe or `-`). The code is a program the parse cannot read, so a caller treats it as a write it cannot see. A script
 * file (`python3 build.py`) and a module (`python3 -m pytest`) are not inline code.
 */
export function inlineInterpreter(name: string, rest: Word[]): boolean {
	const flag = CODE_FLAGS.get(family(name));
	if (flag === undefined) return false;
	if (rest.some((word) => word !== undefined && flag.test(word))) return true;
	if (rest.some((word) => word !== undefined && (INFORMATION.test(word) || word === "-m" || word === "-M")))
		return false;
	return operandsOf(rest).length === 0;
}
