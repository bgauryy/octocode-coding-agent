import { underDirectory } from "../bash-cwd.ts";
import type { BashCommand } from "../bash-types.ts";

/**
 * Where programs that name their destination in an option or a fixed place write, for `shell/mutation.ts`: `dd of=`,
 * `curl -o`, `wget -O`/`-P`, `rsync`'s last operand, `unzip -d`, `tar -cf`/`tar -x -C`, `git -C`, `git config`'s file,
 * `git clone`/`init`/`worktree` paths, git output options (`diff --output`, `format-patch -o`, `archive -o`), a package manager's `--prefix`, and `find`'s `-delete` roots, `-fprint` files
 * and `-exec` commands. An `undefined` word is an expansion the parse could not resolve.
 */
type Word = string | undefined;

export interface Destinations {
	/** Files (or directories) the command names as written. */
	writes: Word[];
	/** Directories changed in place without naming files (a repository `git -C` names, a `tar -C` extraction); none: where the command runs. */
	areas: Word[];
	/** Why the destination cannot be named (`npm -g` writes to the global prefix). */
	unknown?: string;
	/** Commands `find -exec` runs, with `{}` replaced by each starting point. */
	payloads?: Word[][];
}

/**
 * The values of an option: `-o v`, `-ov`, `-xo v` (a cluster ending in the letter), `--output v`, `--output=v`.
 * `letters` are single-letter short options (case-sensitive); `long` are full long names.
 */
export function optionValues(words: Word[], letters: string, long: string[] = []): Word[] {
	const values: Word[] = [];
	for (let at = 0; at < words.length; at++) {
		const word = words[at];
		if (word === undefined || word === "--") {
			if (word === "--") break;
			continue;
		}
		const joined = long.find((name) => word.startsWith(`${name}=`));
		if (long.includes(word)) values.push(words[++at]);
		else if (joined) values.push(word.slice(joined.length + 1));
		else if (letters && /^-[a-zA-Z]/.test(word) && !word.startsWith("--")) {
			const cluster = new RegExp(`^-[a-zA-Z]*?[${letters}](.*)$`).exec(word);
			if (cluster) values.push(cluster[1] ? cluster[1] : words[++at]);
		}
	}
	return values;
}

/** The repository directory `git -C a -C b` runs in (`a/b`), or `""` for where it was started. */
export function gitLocation(globals: Word[]): Word {
	let location: Word = "";
	for (let at = 0; at < globals.length; at++)
		if (globals[at] === "-C") {
			const next = globals[++at];
			location = next === undefined || location === undefined ? undefined : underDirectory(location, next);
		}
	return location;
}

const under = (location: Word, file: Word): Word =>
	location === undefined || file === undefined ? undefined : underDirectory(location, file);

/**
 * The options of a git subcommand that name the file or directory it writes, as `optionValues` reads them: diff's
 * `--output` (any subcommand that parses diff options: diff.c), `archive -o`/`--output` (archive.c) and `format-patch
 * -o`/`--output-directory` (builtin/log.c). No other short `-o` writes (`ls-files -o` is `--others`).
 */
interface Outputs {
	letters: string;
	long: string[];
}
const GIT_OUTPUTS: Record<string, Outputs> = {
	archive: { letters: "o", long: ["--output"] },
	"format-patch": { letters: "o", long: ["--output-directory", "--output"] },
};
const DIFF_OUTPUT: Outputs = { letters: "", long: ["--output"] };

/** The files a git subcommand's `words` write through `outputs`, and an abbreviated output option (`--output-dir=p`, which git accepts) the guard cannot place. */
function gitOutputs(words: Word[], outputs: Outputs): { writes: Word[]; unknown?: string } {
	const end = words.indexOf("--");
	const abbreviated = (end < 0 ? words : words.slice(0, end)).find((word) => {
		const name = word?.startsWith("--") ? word.split("=")[0] : "";
		return name.length > 2 && !outputs.long.includes(name) && outputs.long.some((full) => full.startsWith(name));
	});
	return {
		writes: optionValues(words, outputs.letters, outputs.long),
		...(abbreviated ? { unknown: `\`git ${abbreviated}\` abbreviates an output option the guard cannot place` } : {}),
	};
}

/**
 * Where a `git` command writes: its `-C` repository (and `--git-dir`/`--work-tree`), the config file `git config` sets,
 * and the files its subcommand's output options name (`diff --output=f`, `format-patch -o dir`, `archive -o f`).
 */
export function gitDestinations(rest: Word[], sub: Word, after: Word[]): Destinations {
	const subAt = rest.indexOf(sub);
	const globals = subAt >= 0 ? rest.slice(0, subAt) : rest;
	const location = gitLocation(globals);
	const named = optionValues(globals, "", ["--git-dir", "--work-tree"]);
	const areas: Word[] = [...named.map((dir) => under(location, dir)), ...(location ? [location] : [])];
	if (sub === "config") {
		const words = rest.slice(subAt + 1);
		const file = optionValues(words, "f", ["--file"]);
		const gitDir = named.length > 0 ? optionValues(globals, "", ["--git-dir"])[0] : undefined;
		const config = words.includes("--global")
			? "~/.gitconfig"
			: words.includes("--system")
				? "/etc/gitconfig"
				: under(location, gitDir === undefined ? ".git/config" : `${gitDir}/config`);
		return { writes: file.length > 0 ? file.map((each) => under(location, each)) : [config], areas: [] };
	}
	if (sub === "clone" || sub === "init")
		areas.push(under(location, sub === "clone" ? (after.length >= 2 ? after.at(-1) : ".") : (after[0] ?? ".")));
	if (sub === "worktree") areas.push(...after.slice(1).map((dir) => under(location, dir)));
	if (sub === undefined || subAt < 0) return { writes: [], areas };
	const outputs = gitOutputs(rest.slice(subAt + 1), GIT_OUTPUTS[sub] ?? DIFF_OUTPUT);
	return { ...outputs, writes: outputs.writes.map((file) => under(location, file)), areas };
}

/** Where a `tar` writes: the archive it creates (`-cf out.tar`, `czf out.tgz`), or the directory it extracts into (`-C dir`). */
function tarDestinations(rest: Word[]): Destinations {
	const first = rest[0] ?? "";
	const bundle = /^[a-zA-Z]+$/.test(first) ? first : "";
	const flags = [bundle, ...rest.filter((word) => /^-[a-zA-Z]+$/.test(word ?? "")).map((word) => word!)].join("");
	const has = (letters: RegExp, ...long: string[]) =>
		letters.test(flags) || rest.some((word) => long.includes(word ?? ""));
	const archives = optionValues(rest, "f", ["--file"]);
	if (bundle.includes("f")) archives.push(rest[1]);
	if (has(/[cruA]/, "--create", "--append", "--update", "--concatenate"))
		return { writes: archives.filter((file) => file !== "-"), areas: [] };
	if (has(/x/, "--extract", "--get")) return { writes: [], areas: optionValues(rest, "C", ["--directory"]) };
	return { writes: [], areas: [] };
}

/** `find`'s starting points (after `-H`/`-L`/`-P`/`-D x`/`-Ox`, before the first expression), `.` when none. */
function findRoots(rest: Word[]): Word[] {
	let at = 0;
	while (/^-(?:[HLP]|O\d*)$/.test(rest[at] ?? "") || rest[at] === "-D") at += rest[at] === "-D" ? 2 : 1;
	const roots: Word[] = [];
	for (; at < rest.length; at++) {
		const word = rest[at];
		if (word !== undefined && (word.startsWith("-") || ["(", "!", ")", ","].includes(word))) break;
		roots.push(word);
	}
	return roots.length > 0 ? roots : ["."];
}

/** What a `find` action writes: `-delete` removes under its starting points, `-fprint` and `-fls` write a file, `-exec` runs a command. */
function findDestinations(rest: Word[]): Destinations {
	const roots = findRoots(rest);
	const found: Destinations = { writes: [], areas: [], payloads: [] };
	for (let at = 0; at < rest.length; at++) {
		const word = rest[at];
		if (word === "-delete") found.writes.push(...roots);
		else if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(word ?? "")) found.writes.push(rest[++at]);
		else if (["-exec", "-execdir", "-ok", "-okdir"].includes(word ?? "")) {
			const end = rest.findIndex((each, index) => index > at && (each === ";" || each === "+"));
			const words = rest.slice(at + 1, end < 0 ? undefined : end);
			for (const root of roots)
				found.payloads!.push(
					words.map((each) =>
						each === undefined || root === undefined
							? each?.includes("{}")
								? undefined
								: each
							: each.replaceAll("{}", root),
					),
				);
			at = end < 0 ? rest.length : end;
		}
	}
	return found;
}

/** A command given as words (a `find -exec` payload), run where `dirs` says; an unresolved word stays unresolved. */
export const literalCommand = (words: Word[], dirs: string[] | undefined): BashCommand => ({
	raw: words.map((word) => word ?? "$?").join(" "),
	tokens: words.map((word) => ({
		raw: word ?? "$?",
		...(word === undefined ? {} : { literal: word }),
		start: 0,
		end: 0,
	})),
	assignments: [],
	ambiguousRedirect: false,
	...(dirs ? { dirs } : {}),
});

const PACKAGE_LOCATIONS = ["--prefix", "--cwd", "--dir", "-C"];

/** A package manager's words without its location options and their values (`npm --prefix ../p install` is `install`). */
export const withoutLocations = (rest: Word[]): Word[] =>
	rest.filter((word, at) => !PACKAGE_LOCATIONS.includes(word ?? "") && !PACKAGE_LOCATIONS.includes(rest[at - 1] ?? ""));

/** The destinations of `name` run with `rest` (its words after the name), or undefined for a program this table does not know. */
export function destinations(name: string, rest: Word[], operands: Word[]): Destinations | undefined {
	switch (name) {
		case "dd":
			return {
				writes: [
					...rest.filter((word) => word?.startsWith("of=")).map((word) => word!.slice(3)),
					...(rest.includes(undefined) ? [undefined] : []),
				],
				areas: [],
			};
		case "curl":
			return {
				writes: optionValues(rest, "o", ["--output"]).filter((file) => file !== "-"),
				areas: optionValues(rest, "", ["--output-dir"]),
			};
		case "wget":
			return {
				writes: optionValues(rest, "O", ["--output-document"]).filter((file) => file !== "-"),
				areas: optionValues(rest, "P", ["--directory-prefix"]),
			};
		case "rsync": {
			const target = operands.length >= 2 ? operands.at(-1) : undefined;
			// `host:path` and `rsync://` name another machine.
			return {
				writes: target !== undefined && /^[^/]*:/.test(target) ? [] : operands.length >= 2 ? [target] : [],
				areas: [],
			};
		}
		case "unzip":
			return { writes: [], areas: optionValues(rest, "d") };
		case "patch":
			return { writes: optionValues(rest, "o", ["--output"]), areas: optionValues(rest, "d", ["--directory"]) };
		case "sort":
			return { writes: optionValues(rest, "o", ["--output"]), areas: [] };
		case "tree":
			return { writes: optionValues(rest, "o"), areas: [] };
		case "uniq":
			return { writes: operands.slice(1, 2), areas: [] };
		case "tar":
			return tarDestinations(rest);
		case "find":
			return findDestinations(rest);
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			return {
				writes: [],
				areas: optionValues(rest, "", PACKAGE_LOCATIONS),
				...(rest.some((word) => word === "-g" || word === "--global" || word === "global")
					? { unknown: `\`${name}\` with \`-g\` writes to the global install folder, outside the repository` }
					: {}),
			};
		default:
			return undefined;
	}
}
