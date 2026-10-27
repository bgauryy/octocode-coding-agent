import path from "node:path";
import { bashSyntax, initializeBashSyntax } from "../bash-syntax.ts";
import type { BashCommand } from "../bash-types.ts";
import { bashCandidates } from "../bash-wrappers.ts";
import { readOnlyCommand } from "./read-only.ts";
import { base, wrappedCommand } from "./words.ts";

/**
 * What a shell command changes, as far as its parse shows: a policy for read-only roles and team reservations, not a
 * sandbox. It sees redirections, `tee`, in-place editors, file-moving programs, git and package-manager commands that
 * change the tree, and scripts passed to `sh -c`. It does not see what an interpreter (`node script.js`, `make`) does.
 */
interface ShellMutation {
	/** Paths the command writes, moves or removes, as written (relative to the command's cwd). */
	writes: string[];
	/** Changes with no path to name (`git commit`, `sed -i`, `npm install`), one short description each. */
	opaque: string[];
	/** The command writes somewhere the parse could not resolve (`> $FILE`), or did not parse. */
	uncertain: boolean;
	/** The parse gave up on (part of) the command: no parser, too large, timed out, or syntax it does not know. Its `writes` may be missing some. */
	unparsed: boolean;
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
/** `git config` and `npm config` read with these; any other form of `git config` changes `.git/config` or `~/.gitconfig`. */
const GIT_CONFIG_READS =
	/^(?:-l|--list|--get(?:-all|-regexp|-urlmatch|-color(?:bool)?)?|--show-(?:origin|scope)|--name-only|--type=.*|-z|--null)$/;
/** Config files and `package.json` fields these package-manager forms rewrite (`npm pkg set`, `npm config set`). */
const PACKAGE_CONFIG_WRITES = new Map([
	["pkg", new Set(["set", "delete", "fix"])],
	["config", new Set(["set", "delete", "edit", "fix"])],
]);
/** Programs that rewrite files they are given and name no destination a parse could follow. */
const OPAQUE_WRITERS = ["patch", "dd", "unzip", "wget", "rsync", "ed", "ex"];
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

type Word = string | undefined;

/** Git options that take the next word as their value (`git -C dir`, `git -c k=v`); `--opt=value` forms carry it in one word. */
const GIT_OPTION_VALUES = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--config-env",
]);

/** The subcommand and its arguments after git's global options (`git -C . -c k=v --no-pager checkout -- f`). */
function gitCommand(rest: Word[]): { sub: Word; after: Word[] } {
	let at = 0;
	while (at < rest.length && rest[at]?.startsWith("-") && rest[at] !== "--")
		at += GIT_OPTION_VALUES.has(rest[at]!) ? 2 : 1;
	const operands = operandsOf(rest.slice(at));
	return { sub: operands[0], after: operands.slice(1) };
}

/** `gawk -i inplace` (also `-iinplace`, `--include=inplace`) rewrites its input files. */
function gawkInPlace(words: Word[]): boolean {
	return words.some(
		(word, index) =>
			(word === "-i" && /^inplace(?:\.awk)?$/.test(words[index + 1] ?? "")) ||
			/^(?:-i|--include=)inplace(?:\.awk)?$/.test(word ?? ""),
	);
}

/** Whether `git config` (its words after `config`, and its operands) writes: any form but a read flag or a single key. */
function changesGitConfig(rest: Word[], after: Word[]): boolean {
	const subAt = rest.findIndex((word) => word === "config");
	const flags = rest.slice(subAt + 1).filter((word) => word?.startsWith("-"));
	if (flags.some((flag) => GIT_CONFIG_READS.test(flag ?? ""))) return false;
	if (
		flags.some((flag) =>
			/^(?:--(?:unset|unset-all|add|replace-all|edit|remove-section|rename-section)|-e)$/.test(flag ?? ""),
		)
	)
		return true;
	// `git config key` reads; `git config key value` writes. A key or value that did not resolve is treated as a write.
	return after.length >= 2 || after.includes(undefined);
}

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
	into.unparsed ||= other.unparsed;
}

function inspect(command: BashCommand, found: ShellMutation, depth: number): void {
	const literals = command.tokens.map((word) => word.literal);
	const executables = new Set<number>();
	for (const index of bashCandidates(command, "deny").executables) {
		// `sudo`, `env`, `exec` and the like run the command after their options: that command is what changes things.
		const real = wrappedCommand(literals, index);
		if (real === undefined) found.uncertain = true;
		else executables.add(real);
		executables.add(index);
	}
	for (const at of executables) {
		const token = command.tokens[at];
		if (token?.literal === undefined) continue;
		const name = base(token.literal);
		const rest: Word[] = command.tokens.slice(at + 1).map((word) => word.literal);
		const options = rest.filter((word) => word?.startsWith("-"));
		const operands = operandsOf(rest);
		const { sub, after } = name === "git" ? gitCommand(rest) : { sub: operands[0], after: operands.slice(1) };
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
		} else if (["awk", "gawk"].includes(name) && gawkInPlace(rest)) {
			found.opaque.push(`${name} -i inplace`);
		} else if (OPAQUE_WRITERS.includes(name)) {
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
			else if (sub === "config" && changesGitConfig(rest, after)) found.opaque.push("git config");
			else if (sub === "worktree" && ["add", "remove", "move", "prune"].includes(after[0] ?? ""))
				found.opaque.push("git worktree");
		} else if (PACKAGE_MANAGERS.has(name)) {
			if (sub === undefined && name === "yarn" && options.length === 0) found.opaque.push("yarn install");
			else if (sub !== undefined && PACKAGE_MUTATING.has(sub)) found.opaque.push(`${name} ${sub}`);
			else if (sub !== undefined && PACKAGE_CONFIG_WRITES.get(sub)?.has(after[0] ?? ""))
				found.opaque.push(`${name} ${sub} ${after[0]}`);
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
	const found: ShellMutation = { writes: [], opaque: [], uncertain: false, unparsed: false };
	if (readOnlyCommand(command)) return found;
	const syntax = bashSyntax(command);
	found.unparsed = syntax.incomplete;
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

/**
 * The paths a reservation check compares for `command`: its parsed writes and, when the parse gave up (`unparsed`), every
 * literal word as well. The parse has a time budget, so on a loaded machine a plain `echo x >> reserved.ts` can come back
 * unparsed; checking its words keeps a reserved path that the command names from being written unchecked. A word that
 * names no reserved path costs a lookup, not a refusal; expansions (`$FILE`) and options are skipped.
 */
export function reservationTargets(command: string): string[] {
	const found = shellMutation(command);
	if (!found.unparsed) return found.writes;
	const words = command
		.split(/[\s;&|<>()`'"]+/)
		.filter((word) => word && !word.startsWith("-") && !/[$*?[\]{}]/.test(word));
	return [...new Set([...found.writes, ...words])];
}

/** Loads the bash parser (once); callers await it before `shellMutation`. A load failure leaves every command unresolved (`uncertain`). */
export const shellParserReady = (): Promise<void> => initializeBashSyntax().catch(() => undefined);
