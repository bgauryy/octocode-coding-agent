import { GIT_OPTION_VALUES, gitOptionsEnd, operandsOf, type Word } from "./program-forms.ts";

/**
 * Programs a git command line names. git runs the value of a setting as a shell command or loads programs and
 * configuration from where it points (git/git 50fe5cc6: `git.c:264-281` `-c` and `--config-env`, `:178-180`
 * `--exec-path=`, `:388` an `alias.*` starting with `!`; `pager.c:100-110` `GIT_PAGER`, `core.pager`, `PAGER`;
 * `editor.c:29-50` `GIT_EDITOR`, `core.editor`, `VISUAL`, `EDITOR`, `GIT_SEQUENCE_EDITOR`; `connect.c:1172-1176`
 * `GIT_SSH_COMMAND`, `core.sshCommand`, `:1406` `GIT_SSH`, `:1046` `GIT_PROXY_COMMAND`; `diff.c:434`, `:565`
 * `diff.external`, `GIT_EXTERNAL_DIFF`; `config.c:458` `include.path`). The keys that run something are open-ended
 * (`filter.*`, `*.textconv`, `credential.helper`, `core.hooksPath`, `core.fsmonitor`, `gpg.program`, `include.path`),
 * so a `-c` setting runs here only when its key is one whose value is data (`DATA_KEYS`) or a program key given a value
 * that runs nothing (`HARMLESS_PROGRAMS`); any other setting is taken as running a program. The team reservation gate
 * refuses these while a peer holds a reservation (`commands.ts`); workspace mode does not judge them (R1-10).
 */

/** Values that run nothing that writes: no program, `cat`, `true`, `false` or `:` (`GIT_PAGER=cat`, `GIT_EDITOR=true`). */
const HARMLESS_PROGRAMS = new Set(["", "cat", "true", "false", ":"]);

/** `-c` keys (lower case; `color.*` and `advice.*` by section) whose value is data: colors, identity, booleans and numbers. */
const DATA_KEYS = new Set([
	"user.name",
	"user.email",
	"author.name",
	"author.email",
	"committer.name",
	"committer.email",
	"core.quotepath",
	"core.abbrev",
	"commit.gpgsign",
	"tag.gpgsign",
	"init.defaultbranch",
	"gc.auto",
	"maintenance.auto",
	"pull.rebase",
	"pull.ff",
	"column.ui",
]);
const DATA_SECTIONS = new Set(["color", "advice"]);
/** `-c` keys whose value git runs as a command: harmless with a value of `HARMLESS_PROGRAMS` (`core.pager=cat`). */
const PROGRAM_KEYS = new Set(["core.pager", "core.editor", "sequence.editor", "core.sshcommand", "core.fsmonitor"]);

/** Environment variables whose value git runs as a command; harmless with a value of `HARMLESS_PROGRAMS`. */
const PROGRAM_VARIABLES = new Set([
	"GIT_SSH_COMMAND",
	"GIT_SSH",
	"GIT_PAGER",
	"PAGER",
	"GIT_EDITOR",
	"GIT_SEQUENCE_EDITOR",
	"EDITOR",
	"VISUAL",
	"GIT_EXTERNAL_DIFF",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"GIT_PROXY_COMMAND",
]);
/** Variables naming where git finds programs or hooks to copy, or the state it reads and writes instead of this checkout's: any value. */
const LOCATION_VARIABLES = new Set([
	"GIT_EXEC_PATH",
	"GIT_TEMPLATE_DIR",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
]);
/** Configuration files: harmless only as `/dev/null`. Any other `GIT_CONFIG*` but `GIT_CONFIG_NOSYSTEM` sets keys (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_PARAMETERS`). */
const CONFIG_FILES = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"]);

/** The value of a word `quoted` as written (`'cat'`, `""`, `cat`), or undefined when it expands something or holds a space. */
function plainValue(quoted: string): string | undefined {
	const match = /^(?:'([^']*)'|"([^"$`\\]*)"|([^'"$`\\\s]*))$/.exec(quoted);
	return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/**
 * Why the assignment `text` (`NAME=value`, as written or as `env` reads it) makes git run a program the line names:
 * a program variable with a value that may run one, a location variable, or configuration set through the environment.
 * Undefined for any other variable, a harmless value, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM`.
 */
export function programSetting(text: string): string | undefined {
	const match = /^([A-Za-z_]\w*)\+?=([\s\S]*)$/.exec(text);
	if (!match) return undefined;
	const [, name, quoted] = match;
	const value = plainValue(quoted);
	const because = `\`${name}=…\` makes git run a program, load configuration or use other state the guard cannot judge`;
	if (PROGRAM_VARIABLES.has(name)) return value !== undefined && HARMLESS_PROGRAMS.has(value) ? undefined : because;
	if (LOCATION_VARIABLES.has(name)) return because;
	if (CONFIG_FILES.has(name)) return value === "/dev/null" ? undefined : because;
	return name.startsWith("GIT_CONFIG") && name !== "GIT_CONFIG_NOSYSTEM" ? because : undefined;
}

/** Why the `-c` (or clone `--config`) setting `setting` may run a program; undefined for a data key or a harmless program value. */
function configSetting(setting: Word): string | undefined {
	if (setting === undefined)
		return "`git -c` is given a setting the line does not spell out, which can make git run a program";
	const equals = setting.indexOf("=");
	const key = (equals < 0 ? setting : setting.slice(0, equals)).toLowerCase();
	const value = equals < 0 ? "true" : setting.slice(equals + 1);
	const parts = key.split(".");
	const short = `${parts[0]}.${parts.at(-1)}`;
	if (DATA_SECTIONS.has(parts[0]) || (parts.length === 2 && DATA_KEYS.has(key))) return undefined;
	if ((PROGRAM_KEYS.has(short) || parts[0] === "pager") && HARMLESS_PROGRAMS.has(value)) return undefined;
	return `\`git -c ${key}\` sets configuration that can make git run a program; only data settings (\`color.*\`, \`user.name\`, \`core.pager=cat\`) run while a peer holds a reservation`;
}

/** A long option by any abbreviation git's parse-options accepts (`--upload` for `--upload-pack`, `--ex=x`). */
const long = (word: Word, ...names: string[]): boolean => {
	if (!word?.startsWith("--")) return false;
	const flag = word.slice(2).split("=")[0];
	return flag !== "" && names.some((name) => name.startsWith(flag));
};

/**
 * Subcommand options that name a program git runs, by subcommand (builtin/fetch.c:2584, pull.c:958, clone.c:979-1012,
 * ls-remote.c:68-77, push.c:728-729, archive.c:692; rebase `-x`, difftool `-x`): the long names (any abbreviation) and
 * a short letter, also at the end of a cluster of flags (`clone -qu x`). fetch's `-u` is `--update-head-ok` and push's
 * `--set-upstream`, so only clone's `-u` counts.
 */
const PROGRAM_OPTIONS: Record<string, { names: string[]; short?: RegExp }> = {
	fetch: { names: ["upload-pack"] },
	pull: { names: ["upload-pack"] },
	"ls-remote": { names: ["upload-pack", "exec"] },
	clone: { names: ["upload-pack", "template", "config"], short: /^-[lsqvn]*[uc]/ },
	push: { names: ["receive-pack", "exec"] },
	archive: { names: ["exec"] },
	rebase: { names: ["exec"], short: /^-[a-zA-Z]*x/ },
	difftool: { names: ["extcmd"], short: /^-[a-zA-Z]*x/ },
};

/**
 * Why `git` given `args` (its words after the program; undefined for a word the line does not spell out; `raws`, their
 * source text) runs a program its command line names: a `-c` setting that may run one (`configSetting`), `--config-env`,
 * `--exec-path=`, a computed word where git reads its own options (it may be any of them), a subcommand option of
 * `PROGRAM_OPTIONS`, a clone `--config` setting, `submodule foreach` or `bisect run`. Undefined otherwise.
 */
export function gitProgram(args: ReadonlyArray<Word>, raws: ReadonlyArray<string>): string | undefined {
	const end = gitOptionsEnd(args);
	for (let at = 0; at < end; at++) {
		const word = args[at]!;
		if (word === "-c") {
			const because = configSetting(args[++at]);
			if (because) return because;
		} else if (word === "--config-env" || word.startsWith("--config-env="))
			return "`git --config-env` sets configuration from the environment, which can make git run a program";
		else if (word.startsWith("--exec-path="))
			return "`git --exec-path=` makes git run a program from a directory the line names";
		else if (GIT_OPTION_VALUES.has(word) && args[at + 1] === undefined && /[$`]/.test(raws[at + 1] ?? "$")) {
			if (!/^"[^"]*"$/.test(raws[at + 1] ?? ""))
				return `\`git ${word} ${raws[at + 1] ?? ""}\` may expand to more options, which can make git run a program`;
			at++;
		} else if (GIT_OPTION_VALUES.has(word)) at++;
	}
	if (end < args.length && args[end] === undefined)
		return `\`git ${raws[end] ?? ""}\` is a word the line does not spell out where git reads its options, which can make git run a program`;
	const sub = args[end];
	const rest = args.slice(end + 1);
	const stop = rest.indexOf("--");
	const options = stop < 0 ? rest : rest.slice(0, stop);
	const runs = sub === undefined ? undefined : PROGRAM_OPTIONS[sub];
	for (let at = 0; runs && at < options.length; at++) {
		const word = options[at];
		const isLong = long(word, ...runs.names);
		const cluster = !isLong && word !== undefined ? runs.short?.exec(word)?.[0] : undefined;
		if (word === undefined || (!isLong && cluster === undefined)) continue;
		// clone's `-c`/`--config` setting is read like `git -c`'s: `-c k=v`, `-ck=v`, `--config=k=v`, `--config k=v`.
		const config =
			sub === "clone" &&
			(isLong ? long(word, "config") && !long(word, "upload-pack", "template") : cluster!.endsWith("c"));
		if (!config) return `\`git ${sub} ${word.split("=")[0]}\` runs a program the line names`;
		const attached = isLong
			? word.includes("=")
				? word.slice(word.indexOf("=") + 1)
				: undefined
			: word.slice(cluster!.length) || undefined;
		const because = configSetting(attached ?? options[++at]);
		if (because) return because;
	}
	const operands = operandsOf(options);
	if ((sub === "submodule" && operands[0] === "foreach") || (sub === "bisect" && operands[0] === "run"))
		return `\`git ${sub} ${operands[0]}\` runs a program the line names`;
	return undefined;
}
