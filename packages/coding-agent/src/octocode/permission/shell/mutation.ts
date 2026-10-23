import path from "node:path";
import { bashSyntax, initializeBashSyntax } from "../bash-syntax.ts";
import type { BashCommand } from "../bash-types.ts";
import { bashCandidates } from "../bash-wrappers.ts";
import { readOnlyCommand } from "./read-only.ts";

/**
 * What a shell command changes, as far as its parse shows: a policy for read-only roles and team reservations, not a
 * sandbox. It sees redirections, `tee`, in-place editors, file-moving programs, git and package-manager commands that
 * change the tree, and scripts passed to `sh -c`. It does not see what an interpreter (`node script.js`, `make`) does.
 */
export interface ShellMutation {
	/** Paths the command writes, moves or removes, as written (relative to the command's cwd). */
	writes: string[];
	/** Changes with no path to name (`git commit`, `sed -i`, `npm install`), one short description each. */
	opaque: string[];
	/** The command writes somewhere the parse could not resolve (`> $FILE`), or did not parse. */
	uncertain: boolean;
}

/** Programs that change every file operand: `rm a b`, `mv a b` (both are changed), `touch`, `mkdir`. */
const ALL_OPERANDS = new Set([
	"rm",
	"rmdir",
	"unlink",
	"shred",
	"mv",
	"touch",
	"mkdir",
	"chmod",
	"chown",
	"chgrp",
	"truncate",
]);
/** Programs that only change their destination: the last operand, or the `-t` / `--target-directory` value. */
const DESTINATION_ONLY = new Set(["cp", "ln", "install"]);
const GIT_MUTATING = new Set([
	"add",
	"am",
	"apply",
	"checkout",
	"cherry-pick",
	"clean",
	"clone",
	"commit",
	"init",
	"merge",
	"mv",
	"pull",
	"push",
	"rebase",
	"reset",
	"restore",
	"revert",
	"rm",
	"switch",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_MUTATING = new Set([
	"install",
	"i",
	"add",
	"remove",
	"rm",
	"uninstall",
	"update",
	"upgrade",
	"link",
	"unlink",
	"publish",
	"ci",
	"dedupe",
	"prune",
	"version",
]);
const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const FIND_ACTIONS = new Set([
	"-delete",
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-fls",
]);

const base = (name: string): string => name.split("/").at(-1) ?? name;
type Word = string | undefined;

/** The words that are not options (a `--` ends them); an unresolved word stays `undefined`. */
function operandsOf(words: Word[]): Word[] {
	const operands: Word[] = [];
	let options = true;
	for (const word of words) {
		if (options && word === "--") options = false;
		else if (!options || word === undefined || !word.startsWith("-")) operands.push(word);
	}
	return operands;
}

/** The script after `-c` (also `-lc`, `-ec`), when it is a plain literal. */
function scriptOf(words: Word[]): Word {
	const flag = words.findIndex((word) => word !== undefined && /^-[a-zA-Z]*c$/.test(word));
	return flag >= 0 ? words[flag + 1] : undefined;
}

function merge(into: ShellMutation, other: ShellMutation): void {
	into.writes.push(...other.writes);
	into.opaque.push(...other.opaque);
	into.uncertain ||= other.uncertain;
}

function inspect(command: BashCommand, found: ShellMutation, depth: number): void {
	for (const at of bashCandidates(command, "deny").executables) {
		const token = command.tokens[at];
		if (token?.literal === undefined) continue;
		const name = base(token.literal);
		const rest: Word[] = command.tokens.slice(at + 1).map((word) => word.literal);
		const options = rest.filter((word) => word?.startsWith("-"));
		const operands = operandsOf(rest);
		const sub = operands[0];
		const after = operands.slice(1);
		const take = (words: Word[]) => {
			for (const word of words) {
				if (word === undefined) found.uncertain = true;
				else found.writes.push(word);
			}
		};
		const mutator = ALL_OPERANDS.has(name) || DESTINATION_ONLY.has(name) || name === "sed";
		if (mutator && command.tokens.slice(0, at).some((word) => word.literal === "xargs")) {
			found.opaque.push(`xargs ${name}`);
		} else if (ALL_OPERANDS.has(name)) {
			take(operands);
		} else if (DESTINATION_ONLY.has(name)) {
			const target = rest.findIndex((word) => word === "-t" || word === "--target-directory");
			take(target >= 0 ? [rest[target + 1]] : operands.length > 0 ? [operands.at(-1)] : []);
		} else if (name === "sed" && options.some((word) => /^-[a-zA-Z]*i|^--in-place/.test(word ?? ""))) {
			found.opaque.push("sed -i");
			// The script is an operand unless `-e` gave it; an extra candidate path is harmless to both callers.
			take(operands);
		} else if (name === "perl" && options.some((word) => /^-[a-zA-Z]*i/.test(word ?? ""))) {
			found.opaque.push("perl -i");
		} else if (["patch", "dd", "unzip", "wget"].includes(name)) {
			found.opaque.push(name);
		} else if (
			name === "curl" &&
			options.some((word) => /^-[a-zA-Z]*[oO]|^--(?:output|remote-name)/.test(word ?? ""))
		) {
			found.opaque.push("curl -o");
		} else if (name === "tar" && rest.some((word) => /^(?:-[a-zA-Z]*x|x[a-zA-Z]*$|--extract)/.test(word ?? ""))) {
			found.opaque.push("tar x");
		} else if (name === "find" && rest.some((word) => FIND_ACTIONS.has(word ?? ""))) {
			found.opaque.push("find with an action");
		} else if (name === "git") {
			if (
				sub !== undefined &&
				(GIT_MUTATING.has(sub) || (sub === "stash" && !["list", "show"].includes(after[0] ?? "")))
			)
				found.opaque.push(`git ${sub}`);
			else if (sub === "worktree" && ["add", "remove", "move", "prune"].includes(after[0] ?? ""))
				found.opaque.push("git worktree");
		} else if (PACKAGE_MANAGERS.has(name)) {
			if (sub === undefined && name === "yarn" && options.length === 0) found.opaque.push("yarn install");
			else if (sub !== undefined && PACKAGE_MUTATING.has(sub)) found.opaque.push(`${name} ${sub}`);
		} else if (SHELL_PROGRAMS.has(name) || name === "eval") {
			const script = name === "eval" ? operands.join(" ") : scriptOf(rest);
			if (script !== undefined && depth < 4 && !operands.includes(undefined))
				merge(found, shellMutation(script, depth + 1));
			else if (script !== undefined || name === "eval" || rest.includes("-c")) found.uncertain = true;
			else if (operands.length === 0) found.opaque.push(`${name} reading a script from stdin`);
		}
	}
}

/**
 * What `command` writes, moves or removes, by its bash parse. A command made only of read-only programs has no effect;
 * one the parser cannot read at all is `uncertain` (a caller decides whether that matters).
 */
export function shellMutation(command: string, depth = 0): ShellMutation {
	const found: ShellMutation = { writes: [], opaque: [], uncertain: false };
	if (readOnlyCommand(command)) return found;
	const syntax = bashSyntax(command);
	for (const target of syntax.targets) {
		if (target.kind !== "write" || target.policyOnly) continue;
		if (target.uncertain || target.path === undefined) found.uncertain = true;
		else found.writes.push(target.path);
	}
	for (const part of syntax.commands) inspect(part, found, depth);
	// After a `cd` a relative operand names a path the cwd does not resolve (the parser already says so for redirects).
	if (syntax.commands.some((part) => part.tokens[0]?.literal === "cd" || part.tokens[0]?.literal === "pushd")) {
		const relative = found.writes.filter((file) => !path.isAbsolute(file));
		if (relative.length > 0) found.uncertain = true;
		found.writes = found.writes.filter((file) => path.isAbsolute(file));
	}
	found.writes = [...new Set(found.writes)];
	return found;
}

/** Loads the bash parser (once); callers await it before `shellMutation`. A load failure leaves every command unresolved (`uncertain`). */
export const shellParserReady = (): Promise<void> => initializeBashSyntax().catch(() => undefined);
