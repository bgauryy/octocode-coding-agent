import path from "node:path";
import { RELATIVE_AFTER_CD, followingBareCd, underDirectory } from "../bash-cwd.ts";
import { bashSyntax, initializeBashSyntax, parseBash } from "../bash-syntax.ts";
import type { BashCommand } from "../bash-types.ts";
import { bashCandidates } from "../bash-wrappers.ts";
import { homeSpelling } from "../file-access.ts";
import { awkEffect } from "./awk-program.ts";
import type { ShellMutation } from "./mutation-types.ts";
import { programSwap } from "./environment.ts";
import { gitRefMove, gitRoleGlobal, gitUnread } from "./git-forms.ts";
import { programSetting } from "./git-programs.ts";
import { inlineInterpreter } from "./inline-interpreter.ts";
import { destinations, gitDestinations, literalCommand, optionValues, withoutLocations } from "./destinations.ts";
import {
	ALL_OPERANDS,
	changesGitConfig,
	DESTINATION_ONLY,
	FIND_ACTIONS,
	gitCommand,
	GIT_MUTATING,
	OPAQUE_WRITERS,
	operandsOf,
	OUTPUT_OPTION,
	PACKAGE_CONFIG_WRITES,
	PACKAGE_MANAGERS,
	PACKAGE_MUTATING,
	PACKAGE_RUNNERS,
	scriptedFiles,
	scriptOf,
	SHELL_PROGRAMS,
	type Word,
} from "./program-forms.ts";
import { runInput, type RunInput } from "./input-runners.ts";
import { inputMayWrite, plainReader, readerWritingOptions, readOnlyCommand } from "./read-only.ts";
import { writerEffect } from "./writers.ts";
import { sedFiles, sedInPlace, sedWrites } from "./sed-script.ts";
import { unrollLoops } from "./loops.ts";
import { base, wrappedCommand } from "./words.ts";

/** The shell entry points `team-surfaces.ts` wires into the team gate: this file's mutation reads and the parsed command list. */
export { parsedShell } from "./commands.ts";

/** Marks the command `uncertain`, keeping the first reason. */
function unsure(found: ShellMutation, because: string): void {
	found.uncertain = true;
	found.uncertainBecause ??= because;
}

/**
 * Records `file`, written by a command that runs in `dirs` (`BashCommand.dirs`): under each directory the command may
 * be in, or as written when no `cd` came before. When a `cd` did (`moved`) but the parse could not follow it, a relative
 * path names no known place and the result is `uncertain`.
 */
function place(
	found: ShellMutation,
	file: string,
	dirs: string[] | undefined,
	moved: boolean,
	into: "writes" | "areas" | "directories" | "databases" | "unreadAreas" = "writes",
): void {
	if (dirs) {
		found[into].push(...dirs.map((dir) => (file === "." && dir !== "" ? dir : underDirectory(dir, file))));
		if (dirs.length > 1 && dirs.some((dir) => underDirectory(dir, file) !== file)) found.afterUnjoinedCd = true;
	} else if (moved && !path.isAbsolute(file) && !file.startsWith("~")) {
		found.uncertain = true;
		found.afterDirectoryChange = true;
	} else found[into].push(file);
}

/** Folds the effect of a script a command runs (`sh -c`) into `into`: the script's relative paths are relative to where the command runs. */
function merge(into: ShellMutation, other: ShellMutation, dirs: string[] | undefined, moved: boolean): void {
	for (const file of other.writes) place(into, file, dirs, moved);
	for (const file of other.directories) place(into, file, dirs, moved, "directories");
	for (const area of other.areas) place(into, area, dirs, moved, "areas");
	into.opaque.push(...other.opaque);
	into.inlineCode.push(...other.inlineCode);
	into.refMoves.push(...other.refMoves);
	into.unread.push(...other.unread);
	for (const area of other.unreadAreas) place(into, area, dirs, moved, "unreadAreas");
	for (const database of other.databases) place(into, database, dirs, moved, "databases");
	into.uncertain ||= other.uncertain;
	if (other.uncertainBecause) into.uncertainBecause ??= other.uncertainBecause;
	if (other.awkUnread) into.awkUnread ??= other.awkUnread;
	if (other.programSwap) into.programSwap ??= other.programSwap;
	into.unparsed ||= other.unparsed;
	if (other.afterDirectoryChange) into.afterDirectoryChange = true;
	if (other.afterUnjoinedCd) into.afterUnjoinedCd = true;
}

/** `octocode backlog get|list`: the product's board reads, which start no session and change nothing (`cli/backlog-command.ts`). */
const readsBoard = (rest: Word[]): boolean => rest[0] === "backlog" && (rest[1] === "get" || rest[1] === "list");

/** The words `readerWritingOptions` reads: a `git` reader's subcommand first, then its words; another reader's words. */
const readerWords = (name: string, sub: Word, rest: Word[]): string[] =>
	(name === "git" ? [sub, ...rest] : rest).filter((word): word is string => word !== undefined);

function inspect(command: BashCommand, found: ShellMutation, depth: number, moved: boolean): void {
	const literals = command.tokens.map((word) => word.literal ?? homeSpelling(word.raw));
	const executables = new Set<number>();
	/** The input runner (`xargs`, `parallel`) in front of a command, by the command's index: its words come in part from input. */
	const fed = new Map<number, RunInput>();
	for (const index of bashCandidates(command, "deny").executables) {
		// `sudo`, `env`, `exec` and the like run the command after their options: that command is what changes things.
		const real = wrappedCommand(literals, index);
		if (real === undefined)
			unsure(
				found,
				`\`${command.tokens[index]?.raw}\` runs a command the guard cannot read (an expansion after its options)`,
			);
		else {
			executables.add(real);
			const input = runInput(literals, index, real);
			if (input?.programFromInput) {
				found.opaque.push(`${input.runner} running its input`);
				unsure(found, `\`${input.runner}\` runs a program named by its input, which the guard cannot read`);
			} else if (input) fed.set(real, input);
		}
		executables.add(index);
	}
	for (const at of executables) {
		const token = command.tokens[at];
		if (token === undefined) continue;
		const program = literals[at];
		// A computed program name (`$X`, `$(…)`, backticks) hides even which program runs: nothing about its writes is known.
		if (program === undefined) {
			unsure(found, `\`${token.raw}\` is a computed program name: the guard cannot tell which program runs`);
			continue;
		}
		const name = base(program);
		const rest: Word[] = literals.slice(at + 1);
		const options = rest.filter((word) => word?.startsWith("-"));
		const operands = operandsOf(PACKAGE_MANAGERS.has(name) ? withoutLocations(rest) : rest);
		const { sub, after } = name === "git" ? gitCommand(rest) : { sub: operands[0], after: operands.slice(1) };
		const take = (words: Word[]) => {
			for (const word of words) {
				if (word === undefined)
					unsure(
						found,
						`\`${command.tokens.find((token) => token.literal === undefined)?.raw ?? name}\` is an expansion, not a path (a variable, glob or substitution)`,
					);
				else place(found, word, command.dirs, moved);
			}
		};
		/** A change with no file to name: recorded as `description`, in the directories `where` names or where the command runs. */
		const changes = (description: string, where: Word[] = []) => {
			found.opaque.push(description);
			for (const area of where.length > 0 ? where : ["."]) {
				if (area === undefined) unsure(found, `\`${name}\` changes a directory named by an expansion`);
				else place(found, area, command.dirs, moved, "areas");
			}
		};
		const named = (name === "git" ? gitDestinations(rest, sub, after) : destinations(name, rest, operands)) ?? {
			writes: [],
			areas: [],
		};
		const awk = awkEffect(name, rest);
		if (name === "git") {
			const move = gitRefMove(rest, sub, after);
			if (move) found.refMoves.push(move);
			// What git is told to run or where to look, in its own options or the environment set for it, whatever it reads.
			const setting = literals.slice(0, at).find((word) => word !== undefined && programSetting(word) !== undefined);
			const before = command.assignments.find(({ raw }) => programSetting(raw) !== undefined)?.raw ?? setting;
			const global = gitRoleGlobal(rest);
			if (global) found.unread.push(`git ${global}`);
			else if (before) found.unread.push(`${before} git`);
			const unread = gitUnread(
				rest,
				command.tokens.slice(at + 1).map((word) => word.raw),
				sub,
				after,
			);
			if (unread) {
				found.unread.push(unread);
				for (const area of named.areas.length > 0 ? named.areas : ["."])
					if (area !== undefined) place(found, area, command.dirs, moved, "unreadAreas");
			}
		}
		// Whichever `octocode` runs (the product or another program by that name), the guard does not model it: the product
		// starts a session of its own, with none of this role's limits. `octocode-cli`, the research CLI agent shells put on
		// PATH (`cli/shim.ts`), runs tools the guard does not model either.
		if (name === "octocode-cli" || (name === "octocode" && !readsBoard(rest))) found.opaque.push(name);
		// Words read at run time may be operands or options (`-delete`, `-o f`): a program judged by its words cannot be judged.
		const input = fed.get(at);
		if (input && inputMayWrite(name, rest, input)) {
			found.opaque.push(`${input.runner} ${name}`);
			unsure(found, `\`${input.runner} ${name}\` takes operands and options from its input`);
		} else if (ALL_OPERANDS.has(name)) {
			const before = found.writes.length;
			take([...operands, ...(name === "mv" ? optionValues(rest, "t", ["--target-directory"]) : [])]);
			if (name === "mkdir") found.directories.push(...found.writes.slice(before));
		} else if (DESTINATION_ONLY.has(name)) {
			const target = optionValues(rest, "t", ["--target-directory"]);
			// A hard link makes its source writable through the new name: the source is changed as much as the link.
			const hard =
				name === "link" || (name === "ln" && !options.some((word) => /^-[a-zA-Z]*s|^--sym/.test(word ?? "")));
			if (hard) take([...operands, ...target]);
			else take(target.length > 0 ? target : operands.length > 0 ? [operands.at(-1)] : []);
		} else if (name === "sed") {
			// With or without `-i` (BSD `-I`), the script's `w` commands and `s///w` flags write the files they name.
			if (sedInPlace(rest)) {
				changes("sed -i");
				take(sedFiles(rest));
			}
			const script = sedWrites(rest);
			take(script.writes);
			if (script.unread) unsure(found, `sed's script ${script.unread}`);
		} else if (name === "perl" && options.some((word) => /^-[a-zA-Z]*i/.test(word ?? ""))) {
			changes("perl -i");
			take(scriptedFiles(rest, /^-[a-zA-Z]*[eE]$/));
		} else if (awk) {
			found.awkUnread ??= awk.because;
			if (awk.inPlace) changes(awk.inPlace.description);
			if (awk.inPlace) take(awk.inPlace.files);
		} else if (OPAQUE_WRITERS.includes(name)) {
			take(named.writes);
			if (name === "ed" || name === "ex") take(operands);
			if (name === "patch" && named.areas.length === 0 && named.writes.length === 0) take(operands.slice(0, 1));
			changes(name, named.areas);
		} else if (
			name === "curl" &&
			options.some((word) => /^-[a-zA-Z]*[oO]|^--(?:output|remote-name)/.test(word ?? ""))
		) {
			take(named.writes);
			changes("curl -o", named.areas);
		} else if (writerEffect(name, rest)) {
			// `gzip f` replaces its operand, `zip x.zip a` and `xxd a b` write an archive or output operand (`writers.ts`).
			const effect = writerEffect(name, rest)!;
			take(effect.writes);
			if (effect.areas.length > 0) changes(name, effect.areas);
			else if (effect.opaque) changes(effect.opaque);
		} else if (name === "tar") {
			// `tar -cf out.tar` names the archive it writes; `tar -x` changes the directory it extracts into.
			take(named.writes);
			if (rest.some((word) => /^(?:-[a-zA-Z]*x|x[a-zA-Z]*$|--extract)/.test(word ?? ""))) changes("tar x", named.areas);
		} else if (name === "find" && rest.some((word) => FIND_ACTIONS.has(word ?? ""))) {
			found.opaque.push("find with an action");
			take(named.writes);
			// `-exec cmd {} ;` runs `cmd` on what it finds: its writes are read like any command's, `{}` as each starting point.
			for (const payload of named.payloads ?? []) {
				if (payload[0] === undefined || depth >= 4) unsure(found, "`find -exec` runs a command the guard cannot read");
				else inspect(literalCommand(payload, command.dirs), found, depth + 1, moved);
			}
		} else if (readerWritingOptions(name, readerWords(name, sub, rest)).length > 0) {
			// A reader given an option that writes (`sort -o f`, `uniq in out`) or runs a program (`rg --pre x`).
			const writing = readerWritingOptions(name, readerWords(name, sub, rest));
			take(named.writes);
			// git's only placed output is `--output` (`gitDestinations`); `git grep -oOvim` runs a pager whatever its `-o`.
			const output = name === "git" ? /^--output(?:=|$)/ : OUTPUT_OPTION;
			const runs = writing.find((option) => option !== "uniq OUTPUT" && !output.test(option));
			if (runs) unsure(found, `\`${name} ${runs}\` writes or runs a program the guard cannot place`);
		} else if (name === "git") {
			// `format-patch -o dir`, `archive -o f`: output options name what they write (`gitDestinations`).
			if (sub !== "config") take(named.writes);
			if (named.unknown) unsure(found, named.unknown);
			if (sub === "config" && changesGitConfig(rest, after)) {
				found.opaque.push("git config");
				take(named.writes);
			} else if (
				sub !== undefined &&
				(GIT_MUTATING.has(sub) || (sub === "stash" && !["list", "show"].includes(after[0] ?? "")))
			)
				changes(`git ${sub}`, named.areas);
			else if (sub === "worktree" && ["add", "remove", "move", "prune"].includes(after[0] ?? ""))
				changes("git worktree", named.areas);
			// Without an output option or exactly `--stdout`, `format-patch` writes `NNNN-subject.patch` where it runs (`git -C`'s repository).
			else if (sub === "format-patch" && named.writes.length === 0 && !named.unknown && !rest.includes("--stdout"))
				changes("git format-patch", named.areas);
		} else if (PACKAGE_MANAGERS.has(name)) {
			const changed =
				sub === undefined && name === "yarn" && options.length === 0
					? "yarn install"
					: sub !== undefined &&
						  (PACKAGE_MUTATING.has(sub) || (sub === "global" && PACKAGE_MUTATING.has(after[0] ?? "")))
						? `${name} ${sub}`
						: sub !== undefined && PACKAGE_CONFIG_WRITES.get(sub)?.has(after[0] ?? "")
							? `${name} ${sub} ${after[0]}`
							: undefined;
			if (changed) changes(changed, named.areas);
			if (changed && named.unknown) unsure(found, named.unknown);
			if (sub !== undefined && PACKAGE_RUNNERS.has(sub)) {
				// `npm exec -- cp a b` runs `cp`: its writes are read like any command's.
				const tail = rest.slice(rest.indexOf(sub) + 1);
				const payload = tail[0] === "--" ? tail.slice(1) : tail;
				if (payload[0] === undefined || payload[0].startsWith("-") || depth >= 4)
					unsure(found, `\`${name} ${sub}\` runs a command the guard cannot read`);
				else inspect(literalCommand(payload, command.dirs), found, depth + 1, moved);
			}
		} else if (inlineInterpreter(name, rest)) {
			// Code on the command line or stdin: the parse cannot read what it writes, and it skips `file`'s checkpoints.
			found.inlineCode.push(`${name} running inline code`);
			place(found, ".", command.dirs, moved, "areas");
		} else if (name === "sqlite3") {
			if (operands[0] !== undefined && !rest.includes("-readonly"))
				place(found, operands[0], command.dirs, moved, "databases");
		} else if (SHELL_PROGRAMS.has(name) || name === "eval") {
			const script = name === "eval" ? operands.join(" ") : scriptOf(rest);
			if (script !== undefined && depth < 4 && !operands.includes(undefined))
				merge(found, shellMutation(script, depth + 1), command.dirs, moved);
			else if (script !== undefined || name === "eval" || rest.includes("-c"))
				unsure(found, `\`${name}\` runs a script the guard cannot read (an expansion, or nested too deep)`);
			else if (operands.length === 0) {
				found.opaque.push(`${name} reading a script from stdin`);
				unsure(found, `\`${name}\` runs a script from its input, which the guard cannot read`);
			}
		}
	}
}

/**
 * What `command` writes, moves or removes, by its bash parse. A command made only of read-only programs has no effect;
 * one the parser cannot read at all is `uncertain` (a caller decides whether that matters).
 */
export function shellMutation(command: string, depth = 0, env: NodeJS.ProcessEnv = process.env): ShellMutation {
	const found: ShellMutation = {
		writes: [],
		directories: [],
		areas: [],
		opaque: [],
		inlineCode: [],
		unread: [],
		unreadAreas: [],
		refMoves: [],
		databases: [],
		uncertain: false,
		unparsed: false,
	};
	if (readOnlyCommand(command)) return found;
	// Every write-target check (state folder, read-only role, reservations, isolated tree) shares this one cd-following.
	// A plain `for` loop is read as the commands it runs per word, so a path spelled with its variable is known.
	const syntax = bashSyntax(unrollLoops(depth === 0 ? followingBareCd(command, env) : command));
	found.unparsed = syntax.incomplete;
	// `bashSyntax` lists no assignment or `-v` test; the tree shows them (an unparsed line is `unparsed` already).
	const swap = parseBash(command, (root) => programSwap(root, true, env));
	if (swap) found.programSwap = swap;
	// A `cd` changes what a relative path names: `BashCommand.dirs` and `BashFileTarget.dirs` say where each part runs.
	const moved = syntax.commands.some((part) => part.movesDirectory === true);
	for (const target of syntax.targets) {
		if (target.kind !== "write" || target.policyOnly) continue;
		const followed = target.uncertain === RELATIVE_AFTER_CD && target.dirs !== undefined;
		const home = target.uncertain === RELATIVE_AFTER_CD ? undefined : homeSpelling(target.raw);
		if (home !== undefined) place(found, home, target.dirs, moved);
		else if (target.path === undefined || (target.uncertain && !followed)) {
			found.uncertain = true;
			if (target.uncertain === RELATIVE_AFTER_CD) found.afterDirectoryChange = true;
			else
				unsure(
					found,
					`\`${target.raw}\` is not a plain path (${target.uncertain ?? "a variable, glob or substitution"})`,
				);
		} else place(found, target.path, target.dirs, moved);
	}
	for (const part of syntax.commands) inspect(part, found, depth, moved);
	// A path also written another way (`mkdir d && mv x d`, `> d`) is not only a directory: it is written more often than created.
	const count = (list: string[], file: string) => list.filter((entry) => entry === file).length;
	found.directories = [...new Set(found.directories)].filter(
		(file) => count(found.writes, file) === count(found.directories, file),
	);
	found.writes = [...new Set(found.writes)];
	found.areas = [...new Set(found.areas)];
	found.unreadAreas = [...new Set(found.unreadAreas)];
	found.databases = [...new Set(found.databases)];
	return found;
}

/**
 * The paths a reservation check compares for `command`: its parsed writes and, when the parse gave up (`unparsed`), every
 * literal word as well. The parse has a time budget, so on a loaded machine a plain `echo x >> reserved.ts` can come back
 * unparsed; checking its words keeps a reserved path that the command names from being written unchecked. A word that
 * names no reserved path costs a lookup, not a refusal; expansions (`$FILE`) and options are skipped, but the value of
 * `--output=x` is a word. A plain reader (`plainReader`: `ls a.ts`, `rg x a.ts`, `sed -n '1,5p' a.ts`) writes nothing
 * whatever its words name, so it keeps only the writes the parse found.
 */
export function reservationTargets(command: string): string[] {
	const found = shellMutation(command);
	if (!found.unparsed || plainReader(command)) return found.writes;
	const words = command
		.split(/[\s;&|<>()`'"=]+/)
		.filter((word) => word && !word.startsWith("-") && !/[$*?[\]{}]/.test(word));
	return [...new Set([...found.writes, ...words])];
}

/** Loads the bash parser (once); callers await it before `shellMutation`. A load failure leaves every command unresolved (`uncertain`). */
export const shellParserReady = (): Promise<void> => initializeBashSyntax().catch(() => undefined);
