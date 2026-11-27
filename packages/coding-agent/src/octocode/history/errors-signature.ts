import { clip, oneLine } from "../shared/text.ts";

/**
 * What kind of mistake an error result shows, for grouping in `errors.ts`: the tool's invalid fields, a command's
 * program with its exit code and first error line, a wrapped MCP error's inner message, or the first line of a refusal
 * with the values that differ between calls removed. Wording that varies for one mistake (a file-guard refusal that names
 * its reader differently, an edit miss for one edit or several) collapses through `FAMILIES`, kept beside the code that
 * signs so a reworded message is fixed in one place.
 */

/** Characters of a signature. */
const SIGNATURE_CHARS = 160;
/** Characters of a command failure's first error line. */
const ERROR_LINE_CHARS = 100;
/** Characters of a program name read from a command. */
const PROGRAM_CHARS = 40;
/** Most distinct inner errors one wrapped result names in its signature. */
const INNER_ERRORS = 2;
/**
 * Characters of a line that `normalise` reads. Signatures are clipped far shorter, and the path and id patterns
 * backtrack quadratically on long dotted or dashed runs (seconds for a 60,000-character error line).
 */
const NORMALISE_CHARS = 1_000;

/** `text` with paths, ids and numbers replaced, so one mistake made with different values groups together. */
function normalise(text: string): string {
	return oneLine(text)
		.slice(0, NORMALISE_CHARS)
		.replace(/(?<![\w/])(?:~|\.{1,2})?\/?[\w.@+~-]+(?:\/[\w.@+~-]+)+\/?/g, "<path>")
		.replace(/\b(?=[0-9a-f-]*\d)[0-9a-f][0-9a-f-]{7,}\b/gi, "<id>")
		.replace(/\b(?:toolu|chatcmpl|call)[\w-]+/g, "<id>")
		.replace(/\d+/g, "N");
}

/**
 * Messages that are one mistake in several wordings, matched against the normalised message (`N`, `<path>`) after the
 * file tool's `N. FAILED <type> <path>: ` prefix is removed. The first match replaces the whole signature.
 */
const FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
	// File guard (`files/tool/guard.ts`): the refusal differs by reader, path spelling and how many edits the call had.
	[
		/^(?:\S+ )?already exists and was not read in this session\b/,
		"file already exists and was not read in this session",
	],
	[/^(?:\S+ )?changed on disk since you last read it\b/, "file changed on disk since it was last read"],
	[/^(?:\S+ )?your earlier read of it is no longer in your context\b/, "file read is no longer in the context"],
	// Edit matching (`core/tools/edit-diff.ts`): one edit says "the exact text", several say `edits[N]`; a hint may follow.
	[
		/^Could not find (?:the exact text|edits\[N\]) in\b/,
		"oldText not found: it must match the file exactly, whitespace included",
	],
	[
		/^Found N occurrences of (?:the text|edits\[N\]) in\b/,
		"oldText matches more than once: add context to make it unique",
	],
	[/^(?:edits\[N\]\.)?oldText must not be empty\b/, "oldText must not be empty"],
	// Permission and reservation refusals that name the command, the interpreter or the holder.
	[
		/^This command runs \S+ on inline code\b/,
		"inline interpreter code refused while another agent holds a reservation",
	],
	[
		/^This command was not run: what it writes cannot be checked against reservations\b/,
		"unreadable command refused while another agent holds a reservation",
	],
	[/^`[^`]*` is refused: this is a read-only role\b/, "`<command>` is refused: this is a read-only role"],
	[
		/^Changing \S+ from the shell\b.*\bis refused: this is a read-only role\b/,
		"Changing <path> from the shell is refused: this is a read-only role",
	],
	[/^Refused: `git [^`]*` changes git state\b/, "Refused: `git <subcommand>` changes git state"],
	[/^(?:\S+ )?is reserved by [\w-]+/, "<path> is reserved by another agent"],
	// An MCP path refusal lists the allowed roots, which differ between sessions.
	[/^Path '[^']*' is outside allowed directories\b/, "path is outside the allowed directories"],
];

/** A file-tool failure line without its `N. FAILED <type> <path>: ` prefix and the path that then opens the message. */
function stripFileFailure(line: string): string {
	const failed = /^\d+\. FAILED \w+ (.+?): (.*)$/.exec(line);
	if (!failed) return line;
	const [, file, message] = failed;
	return message.startsWith(`${file} `) ? message.slice(file.length + 1) : message;
}

/** The signature of a refusal's first line: its family when it is a known one, else the line with values removed. */
function lineSignature(line: string): string {
	const text = normalise(stripFileFailure(line));
	for (const [pattern, family] of FAMILIES) if (pattern.test(text)) return family;
	return text;
}

/** The signature of every `error` an MCP result's JSON names, as `code: message`, without repeats. */
function innerErrors(value: unknown, found: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) innerErrors(item, found);
	} else if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.error === "string") {
			const code = typeof record.errorCode === "string" ? `${record.errorCode}: ` : "";
			const inner = `${code}${lineSignature(record.error)}`;
			if (!found.includes(inner)) found.push(inner);
		} else {
			for (const item of Object.values(record)) innerErrors(item, found);
		}
	}
	return found;
}

/**
 * The inner messages of an MCP error that carries them as JSON, bare or inside an `<<<untrusted-…` fence below a
 * `Server tool:` line, so errors that differ only in that wrapper do not share a group. Undefined for any other text.
 */
function unwrapped(text: string): string | undefined {
	const fenced = /^[^\n]*\n<<<untrusted-[^\n]*\n([\s\S]*?)\nuntrusted-[\w-]+>>>\s*$/.exec(text.trim());
	const body = fenced ? fenced[1] : text.trim();
	if (!body.startsWith("{")) return undefined;
	try {
		const errors = innerErrors(JSON.parse(body) as unknown);
		return errors.length ? errors.slice(0, INNER_ERRORS).join("; ") : undefined;
	} catch {
		return undefined;
	}
}

/** A first output line that says nothing about what failed: banners, summaries, separators, bare numbers and diff marks. */
const NOISE =
	/^(?:RUN\b|Finished in\b|Checking formatting|Test Files\b|Tests\b|Duration\b|Start at\b|Verification:|[·.\s]+$|[⎯─=\-+]+$|[-+] |\d+$|\(no output\)$|\{)/;
/** A test runner's summary of failed tests: the best single line for a run that failed tests. */
const TESTS_FAILED = /Failed Tests\b|No test files found/;
/**
 * A line that names a failure, as tools word one: a diagnostic, an operating-system message or a failing test. A command
 * that exits non-zero while printing a file (a `grep` with no match after a `cat`) has no such line.
 */
const FAILURE_LINE =
	/^(?:[\w./-]+: )?(?:error|fatal|FAIL)\b|\berror TS\d+|^AssertionError|\b(?:no such file|command not found|illegal option|invalid (?:option|command|argument)|undefined label|permission denied|not found|cannot find|unexpected (?:argument|EOF|token))\b|\b\d+ (?:errors?|problems?|failed)\b/i;
/** The prefix tools put before a message when they name themselves: `sed: 1: …`. Not these words, which describe the message. */
const TOOL_PREFIX = /^([a-z][\w.-]*): /;
const NOT_A_TOOL = new Set(["error", "fatal", "warning", "note", "hint", "info", "usage", "fail"]);

/**
 * The line of a command's output that most likely names why it failed, without colours and the values that differ
 * between runs, and the tool that printed it when the line names itself.
 */
function errorLine(lines: readonly string[]): { line: string; bare: string; tool?: string } {
	const usable = lines.filter((line) => !NOISE.test(line));
	const found = usable.find((line) => TESTS_FAILED.test(line)) ?? usable.find((line) => FAILURE_LINE.test(line));
	if (found === undefined) return { line: "(no error line)", bare: "(no error line)" };
	// A test runner's `FAIL <file> > suite > name` differs by test name: the file is the stable part.
	const plain = found
		.slice(0, NORMALISE_CHARS)
		.replace(/^(FAIL\s+\S+) > .*$/, "$1")
		.replace(/^[⎯\s]+|[⎯\s]+$/g, "");
	const tool = TOOL_PREFIX.exec(plain)?.[1];
	const named = tool !== undefined && !NOT_A_TOOL.has(tool);
	return {
		line: clip(normalise(plain), ERROR_LINE_CHARS),
		// Without the tool's own name, for a signature that already starts with the program.
		bare: clip(normalise(named ? plain.slice(tool.length + 2) : plain), ERROR_LINE_CHARS),
		...(named ? { tool } : {}),
	};
}

/** Commands that only prepare the shell before the one that does the work. */
const PRELUDE = new Set([
	"cd",
	"export",
	"set",
	"source",
	".",
	"echo",
	"printf",
	"true",
	"false",
	":",
	"mkdir",
	"unset",
	"pushd",
	"popd",
]);
/** Words that wrap the command they run. */
const WRAPPERS = new Set(["time", "env", "nohup", "command", "exec", "timeout", "sudo"]);
/** Package runners: the program is what they run. */
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
/** Package managers: `yarn vitest`, `yarn run check`, `pnpm exec oxlint`. */
const MANAGERS = new Set(["yarn", "npm", "pnpm", "bun"]);
/** Programs whose first word after them names what they do. */
const SUBCOMMANDED = new Set(["git", "gh", "cargo", "docker", "go"]);

/** The program a shell command line runs, to tell failures of `vitest` from failures of `oxlint` or `git`. Undefined when none is readable. */
export function commandProgram(command: string): string | undefined {
	const bare = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "Q");
	for (const segment of bare.split(/&&|\|\||[;|\n]/)) {
		const words = segment.trim().split(/\s+/).filter(Boolean);
		// A loop or condition head runs nothing itself; its body is a later segment.
		if (/^(?:for|while|until|if|case|select)$/.test(words[0] ?? "")) continue;
		if (/^(?:do|then|else|elif)$/.test(words[0] ?? "")) words.shift();
		let at = 0;
		while (at < words.length && (/^[\w]+=/.test(words[at]) || /^[({!]+$/.test(words[at]) || WRAPPERS.has(words[at]))) {
			if (words[at] === "timeout") at++;
			at++;
		}
		const name = (word: string | undefined) => word?.replace(/^[({!]+/, "").replace(/^.*\//, "") ?? "";
		const head = name(words[at]);
		// A word that is no program name (a flag or file left by a quote or a heredoc) names nothing.
		if (!/^[A-Za-z][\w+-]*(?:\.(?:sh|mjs|js|py))?$/.test(head) || PRELUDE.has(head)) continue;
		const rest = words.slice(at + 1).filter((word) => !word.startsWith("-"));
		if (RUNNERS.has(head) && rest[0]) return clip(name(rest[0]), PROGRAM_CHARS);
		if (MANAGERS.has(head)) {
			const words2 = rest[0] === "workspace" ? rest.slice(2) : rest;
			const sub = words2[0] === "run" || words2[0] === "exec" || words2[0] === "dlx" ? words2[1] : words2[0];
			return clip(sub ? `${head} ${name(sub)}` : head, PROGRAM_CHARS);
		}
		if (SUBCOMMANDED.has(head) && rest[0]) return clip(`${head} ${rest[0]}`, PROGRAM_CHARS);
		return clip(head, PROGRAM_CHARS);
	}
	return undefined;
}

export interface ClassifiedError {
	/** What kind of mistake the error shows. */
	signature: string;
	/** A command's own failure (a non-zero exit, a timeout): the work the command did, not a refusal by the harness or a tool. */
	command: boolean;
}

/** A bash result that is a command's outcome: the new `[exit N …]` header, or the old trailing `Command exited with code N`. */
function commandOutcome(lines: readonly string[]): { label: string; output: string[] } | undefined {
	const first = lines[0] ?? "";
	const exit = /^\[exit (\d+|[a-z]+)\b/.exec(first);
	if (exit) return { label: `exit ${exit[1]}`, output: lines.slice(1) };
	if (/^\[timed out after\b/.test(first)) return { label: "timed out", output: lines.slice(1) };
	const last = lines.at(-1) ?? "";
	const old = /^Command exited with code (\d+)$/.exec(last);
	if (old) return { label: `exit ${old[1]}`, output: lines.slice(0, -1) };
	if (/^Command timed out after\b/.test(last)) return { label: "timed out", output: lines.slice(0, -1) };
	if (last === "Command aborted") return { label: "aborted", output: lines.slice(0, -1) };
	return undefined;
}

/**
 * What kind of mistake an error result shows, and whether it is a command's own failure. `command` is the shell command
 * line the call ran, when the transcript has it: it names the program in a command failure's signature.
 */
export function classifyError(text: string, command?: string): ClassifiedError {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const first = lines[0] ?? "(empty error)";
	if (/^Validation failed for tool\b/.test(first)) {
		const fields: string[] = [];
		for (const line of lines.slice(1)) {
			if (!line.startsWith("- ")) break;
			const field = normalise(line.slice(2));
			if (!fields.includes(field)) fields.push(field);
		}
		return {
			command: false,
			signature: clip(`invalid arguments: ${fields.join("; ") || "(no fields named)"}`, SIGNATURE_CHARS),
		};
	}
	const outcome = commandOutcome(lines);
	if (outcome) {
		const clean = outcome.output.map((line) => line.replace(/(?:\u001b\[|\^\[\[)[0-9;]*m/g, ""));
		// A timeout or an abort has no error line of its own.
		const failure = outcome.label.startsWith("exit") ? errorLine(clean) : undefined;
		// The command names the program it ran, but a chain may fail in another: a line that names its tool wins.
		const guess = command === undefined ? undefined : commandProgram(command);
		const program = guess === undefined ? undefined : (failure?.tool ?? guess);
		const tail = failure ? `: ${program ? failure.bare : failure.line}` : "";
		return {
			command: true,
			signature: clip(`${program ? `${program} ` : ""}${outcome.label}${tail}`, SIGNATURE_CHARS),
		};
	}
	return { command: false, signature: clip(unwrapped(text) ?? lineSignature(first), SIGNATURE_CHARS) };
}

/** The signature of an error result's text (see `classifyError`). */
export function errorSignature(text: string, command?: string): string {
	return classifyError(text, command).signature;
}
