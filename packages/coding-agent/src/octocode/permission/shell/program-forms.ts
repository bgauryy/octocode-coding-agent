/** The forms of the programs `mutation.ts` reads: which change their operands, their destination, the tree or config. */
import { WRITER_PROGRAMS } from "./writers.ts";

/** Programs that change every file operand: `rm a b`, `mv a b` (both are changed), `touch`, `mkdir`. */
export const ALL_OPERANDS = new Set([
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
	"mkfifo",
	"mktemp",
]);
/** Programs that only change their destination: the last operand, or the `-t` / `--target-directory` value. */
export const DESTINATION_ONLY = new Set(["cp", "ln", "install", "link"]);
/** Package-manager subcommands that run the command after them (`npm exec -- tsc`, `pnpm dlx x`, `bun x y`). */
export const PACKAGE_RUNNERS = new Set(["exec", "x", "dlx"]);
/** Reader options that name the file they write (`sort -o f`, `tree -o f`); git's are its subcommand's (destinations.ts `gitDestinations`). */
export const OUTPUT_OPTION = /^(?:-[a-zA-Z0-9]*o|--output)/;
export const GIT_MUTATING = new Set([
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
export const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
export const PACKAGE_MUTATING = new Set([
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
export const PACKAGE_CONFIG_WRITES = new Map([
	["pkg", new Set(["set", "delete", "fix"])],
	["config", new Set(["set", "delete", "edit", "fix"])],
]);
/** Programs that rewrite files they are given and name no destination a parse could follow. */
export const OPAQUE_WRITERS = ["patch", "dd", "unzip", "wget", "rsync", "ed", "ex"];
export const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
export const FIND_ACTIONS = new Set([
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

/**
 * The writers whose writes `mutation.ts` reads from their words: operands, destinations, in-place and output options, a
 * shell's script. Behind an input runner (`xargs`, `parallel`) words read at run time can change what they write. The
 * readers with writing options are `read-only.ts`'s, which joins both (`inputMayWrite`). sed's script and in-place
 * files are read by `sed-script.ts`.
 */
export const WORD_WRITERS = new Set([
	...ALL_OPERANDS,
	...DESTINATION_ONLY,
	...OPAQUE_WRITERS,
	...PACKAGE_MANAGERS,
	...SHELL_PROGRAMS,
	...WRITER_PROGRAMS,
	"sed",
	"perl",
	"awk",
	"gawk",
	"curl",
	"tar",
	"tee",
	"eval",
]);

export type Word = string | undefined;

/** Git options that take the next word as their value (`git -C dir`, `git -c k=v`); `--opt=value` forms carry it in one word. */
export const GIT_OPTION_VALUES: ReadonlySet<string> = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--config-env",
]);

/**
 * Where git's global options end among its words: git reads them up to the first word that does not start with `-`
 * (git.c `handle_options`), and that word is the subcommand.
 */
export function gitOptionsEnd(rest: ReadonlyArray<Word>): number {
	let at = 0;
	while (at < rest.length && rest[at]?.startsWith("-") && rest[at] !== "--")
		at += GIT_OPTION_VALUES.has(rest[at]!) ? 2 : 1;
	return at;
}

/** The subcommand and its arguments after git's global options (`git -C . -c k=v --no-pager checkout -- f`). */
export function gitCommand(rest: Word[]): { sub: Word; after: Word[] } {
	const operands = operandsOf(rest.slice(gitOptionsEnd(rest)));
	return { sub: operands[0], after: operands.slice(1) };
}

/** `gawk -i inplace` (also `-iinplace`, `--include=inplace`) rewrites its input files. */
export function gawkInPlace(words: Word[]): boolean {
	return words.some(
		(word, index) =>
			(word === "-i" && /^inplace(?:\.awk)?$/.test(words[index + 1] ?? "")) ||
			/^(?:-i|--include=)inplace(?:\.awk)?$/.test(word ?? ""),
	);
}

/** Whether `git config` (its words after `config`, and its operands) writes: any form but a read flag or a single key. */
export function changesGitConfig(rest: Word[], after: Word[]): boolean {
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

/**
 * The files a program given a script (`perl -i`, `gawk -i inplace`) rewrites: its operands, without the script. The
 * script is the value of an option that `scriptOption` matches, or else the first operand.
 */
export function scriptedFiles(words: Word[], scriptOption: RegExp): Word[] {
	const files: Word[] = [];
	let scripted = false;
	for (let at = 0; at < words.length; at++) {
		const word = words[at];
		if (word !== undefined && scriptOption.test(word)) {
			scripted = true;
			at++;
		} else if (word === undefined || !word.startsWith("-")) files.push(word);
	}
	// `gawk -i inplace`'s value is not a file either.
	const named = files.filter((file) => file !== "inplace" && file !== "inplace.awk");
	return scripted ? named : named.slice(1);
}

/** The words that are not options (a `--` ends them); an unresolved word stays `undefined`. */
export function operandsOf(words: Word[]): Word[] {
	const operands: Word[] = [];
	let options = true;
	for (const word of words) {
		if (options && word === "--") options = false;
		else if (!options || word === undefined || !word.startsWith("-")) operands.push(word);
	}
	return operands;
}

/** The script after `-c` (also `-lc`, `-ec`), when it is a plain literal. */
export function scriptOf(words: Word[]): Word {
	const flag = words.findIndex((word) => word !== undefined && /^-[a-zA-Z]*c$/.test(word));
	return flag >= 0 ? words[flag + 1] : undefined;
}
