import { bashSyntax } from "../permission/bash-syntax.ts";
import type { BashCommand } from "../permission/bash-types.ts";
import { awkEffect } from "../permission/shell/awk-program.ts";
import { awkWords } from "../permission/shell/program-forms.ts";
import { readOnlyCommand } from "../permission/shell/read-only.ts";
import { sedInPlace, sedWrites } from "../permission/shell/sed-script.ts";
import { wrappedCommand } from "../permission/shell/words.ts";

/**
 * Whether clearing may replace a bash result with a placeholder that says "run the call again": running the line again
 * only prints. It accepts what `readOnlyCommand` accepts, and also a line whose `sed` only prints (no `-i`, `w`, `e` or
 * script file: `sedWrites` reads the whole script) and whose `awk` reads its whole program and finds no redirect, pipe,
 * `system` or `getline` (`awkEffect`), in a list, pipeline or after `cd`. Every other simple command must pass
 * `readOnlyCommand` on its own, and the bash parse must read the whole line and find no write target.
 *
 * Clearing keeps its own rule because `readOnlyCommand` gates plan mode and the reservation gate, where a wider reading
 * would let a command run unchecked; here a wrong "yes" costs one re-run of a printing command whose output was saved.
 */
export function clearableBash(command: string, shell: "bash" | "powershell"): boolean {
	if (readOnlyCommand(command, shell)) return true;
	if (shell === "powershell") return false;
	const syntax = bashSyntax(command);
	if (syntax.incomplete || syntax.commands.length === 0) return false;
	if (syntax.targets.some((target) => target.kind === "write")) return false;
	return syntax.commands.every(printsOnly);
}

/** One simple command of a parsed line: a printing `sed` or `awk` run directly, or any command `readOnlyCommand` accepts. */
function printsOnly(part: BashCommand): boolean {
	const literals = part.tokens.map((token) => token.literal);
	// A wrapper (`xargs`, `env`) or an assignment in front may add words or change what runs: only the general check judges it.
	if (part.assignments.length === 0 && wrappedCommand(literals, 0) === 0) {
		const [name, ...rest] = literals;
		if (name === "sed") return printingSed(rest);
		if (name !== undefined && awkWords(name, rest) !== undefined) return awkEffect(name, rest) === undefined;
	}
	return readOnlyCommand(part.raw);
}

/** A `sed` call, by its words after `sed`, that edits nothing in place and whose script, read whole, writes and runs nothing. */
function printingSed(words: Array<string | undefined>): boolean {
	if (sedInPlace(words)) return false;
	const script = sedWrites(words);
	return script.unread === undefined && script.writes.length === 0;
}
