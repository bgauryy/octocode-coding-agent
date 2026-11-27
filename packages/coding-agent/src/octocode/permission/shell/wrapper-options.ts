/**
 * The option grammar of commands that run another command (`sudo`, `env`, `xargs`, `flock`...), for `words.ts`. A
 * wrapper's options either take the next word as their value or stand alone; an option this table does not know may
 * take a value, so the word after it may or may not be the command, and the caller that needs certainty fails closed.
 */

/** Commands that only run the rest of the line (after their own options and leading operands) as another command. */
export const WRAPPERS = new Set([
	"sudo",
	"doas",
	"command",
	"exec",
	"nohup",
	"time",
	"env",
	"xargs",
	"parallel",
	"timeout",
	"nice",
	"ionice",
	"stdbuf",
	"caffeinate",
	"chrt",
	"taskset",
	"setsid",
	"flock",
	"arch",
	"coproc",
	"watch",
	"npx",
	"bunx",
	"uv",
	"poetry",
	"pipenv",
	"pyenv",
	"conda",
	"rye",
]);

/** Wrapper options that take the next word as their value (`sudo -u root rm …`: `root` is not the command). */
const OPTION_ARGS: Record<string, ReadonlySet<string>> = {
	sudo: new Set([
		"-u",
		"-g",
		"-h",
		"-p",
		"-C",
		"-D",
		"-R",
		"-r",
		"-T",
		"-t",
		"-U",
		"--user",
		"--group",
		"--host",
		"--prompt",
		"--close-from",
		"--chdir",
		"--chroot",
		"--role",
		"--type",
		"--command-timeout",
		"--other-user",
	]),
	doas: new Set(["-u", "-C"]),
	// BSD and macOS `env` take `-P altpath`, `-L user` and `-U user`.
	env: new Set(["-u", "--unset", "-C", "--chdir", "-P", "-L", "-U"]),
	exec: new Set(["-a"]),
	// `--replace`, `--eof` and `--max-lines` take a value only joined by `=`.
	xargs: new Set([
		"-I",
		"-J",
		"-L",
		"-n",
		"-P",
		"-s",
		"-d",
		"-E",
		"-a",
		"-R",
		"-S",
		"--max-args",
		"--max-procs",
		"--max-chars",
		"--delimiter",
		"--arg-file",
		"--process-slot-var",
	]),
	// GNU parallel's options that write or run elsewhere (`--results`, `--joblog`, `--tmpdir`, `--wd`, `-S`) are left out on purpose.
	parallel: new Set([
		"-j",
		"-P",
		"-n",
		"-N",
		"-L",
		"-d",
		"-I",
		"-C",
		"-a",
		"--jobs",
		"--max-args",
		"--max-lines",
		"--delimiter",
		"--colsep",
		"--arg-file",
		"--timeout",
		"--halt",
		"--delay",
		"--tagstring",
	]),
	timeout: new Set(["-k", "-s", "--kill-after", "--signal"]),
	nice: new Set(["-n", "--adjustment"]),
	ionice: new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"]),
	stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
	caffeinate: new Set(["-t", "-w"]),
	flock: new Set(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"]),
	watch: new Set(["-n", "--interval", "-q", "--equexit"]),
	conda: new Set(["-n", "--name", "-p", "--prefix"]),
	npx: new Set(["-p", "--package"]),
	bunx: new Set(["-p", "--package"]),
	chrt: new Set(["-T", "-P", "-D", "--sched-runtime", "--sched-period", "--sched-deadline"]),
};

/**
 * Wrapper options known to take no value. Options that make the wrapper run something else (`sudo -e` edits files,
 * `flock -c` and `npx -c` run a shell string, `chrt -p` and `taskset -p` act on a process) are left out on purpose.
 */
const FLAGS: Record<string, ReadonlySet<string>> = {
	sudo: new Set(
		["-A", "-b", "-E", "-H", "-i", "-K", "-k", "-n", "-P", "-S", "-s", "-B", "-N"].concat([
			"--askpass",
			"--background",
			"--preserve-env",
			"--set-home",
			"--login",
			"--non-interactive",
			"--stdin",
			"--shell",
			"--reset-timestamp",
			"--remove-timestamp",
			"--preserve-groups",
			"--bell",
		]),
	),
	doas: new Set(["-n", "-s", "-L"]),
	command: new Set(["-p"]),
	exec: new Set(["-c", "-l"]),
	time: new Set(["-p", "-l", "-h"]),
	env: new Set(["-", "-i", "-0", "-v", "--ignore-environment", "--null", "--debug"]),
	xargs: new Set([
		"-0",
		"-r",
		"-t",
		"-p",
		"-x",
		"-o",
		"-i",
		"-e",
		"-l",
		"--null",
		"--no-run-if-empty",
		"--verbose",
		"--interactive",
		"--exit",
		"--open-tty",
		"--replace",
		"--eof",
		"--max-lines",
	]),
	parallel: new Set(
		["-0", "-k", "-q", "-v", "-t", "-u", "-X", "-m", "-r", "-g", "--null", "--keep-order", "--quote"].concat(
			["--verbose", "--tag", "--ungroup", "--line-buffer", "--group", "--xargs", "--no-run-if-empty"],
			["--will-cite", "--dry-run", "--bar", "--progress", "--eta", "--pipe"],
		),
	),
	timeout: new Set(["--foreground", "--preserve-status", "-v", "--verbose"]),
	ionice: new Set(["-t", "--ignore"]),
	caffeinate: new Set(["-d", "-i", "-m", "-s", "-u"]),
	chrt: new Set([
		"-b",
		"-f",
		"-i",
		"-o",
		"-r",
		"-d",
		"-R",
		"-a",
		"-v",
		"--batch",
		"--fifo",
		"--idle",
		"--other",
		"--rr",
	]),
	taskset: new Set(["-a", "-c", "--all-tasks", "--cpu-list"]),
	setsid: new Set(["-c", "-f", "-w", "--ctty", "--fork", "--wait"]),
	flock: new Set(["-s", "-x", "-e", "-n", "-u", "-o", "-F", "--shared", "--exclusive", "--nonblock", "--unlock"]),
	arch: new Set(["-arm64", "-arm64e", "-x86_64", "-x86_64h", "-i386", "-32", "-64"]),
	watch: new Set(["-d", "-t", "-b", "-e", "-g", "-c", "-p", "-w", "--differences", "--no-title", "--beep"]),
	npx: new Set(["-y", "--yes", "--no", "-q", "--quiet", "--no-install", "--ignore-existing"]),
	bunx: new Set(["--bun"]),
};

/** Operands a wrapper takes before the command it runs (`timeout 5 rm …`, `chrt 10 rm …`, `taskset 0x3 rm …`). */
export const LEADING_OPERANDS: Record<string, number> = {
	timeout: 1,
	chrt: 1,
	taskset: 1,
	flock: 1,
	uv: 1,
	poetry: 1,
	pipenv: 1,
	pyenv: 1,
	conda: 1,
	rye: 1,
};

/**
 * How many words `option` of `wrapper` spans: 2 when its value is the next word, 1 when it stands alone or carries its
 * value (`-n5`, `--signal=KILL`, a cluster of flags), undefined when the table does not know it.
 */
export function optionWidth(wrapper: string, option: string): 1 | 2 | undefined {
	const values = OPTION_ARGS[wrapper];
	const flags = FLAGS[wrapper];
	if (values?.has(option)) return 2;
	if (flags?.has(option)) return 1;
	if (wrapper === "nice" && /^-\d+$/.test(option)) return 1;
	if (option.startsWith("--")) {
		const name = option.split("=")[0];
		return option.includes("=") && (values?.has(name) || flags?.has(name)) ? 1 : undefined;
	}
	// A short cluster: flags, possibly ending in an option whose value is attached (`-n5`) or is the next word.
	for (let at = 1; at < option.length; at++) {
		const letter = `-${option[at]}`;
		if (values?.has(letter)) return at + 1 < option.length ? 1 : 2;
		if (!flags?.has(letter)) return undefined;
	}
	return 1;
}
