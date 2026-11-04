import path from "node:path";
import { currentToolRoles } from "../../../../mcp/src/roles.ts";

/** Hints one session can receive: enough to reach the model, too few to become noise. */
export const READ_HINT_LIMIT = 3;

/** The research role that replaces each read command: a search role finds, the reader role prints known lines. */
type ReadRole = "search" | "reader";
const READ_TOOL: Record<string, ReadRole> = {
	rg: "search",
	grep: "search",
	find: "search",
	ls: "search",
	cat: "reader",
	head: "reader",
	tail: "reader",
	sed: "reader",
	nl: "reader",
};

/** Commands that may receive a read's output through a pipe and only narrow it. */
const FILTERS = new Set(["head", "tail", "cut", "sort", "uniq", "wc", "grep", "rg", "cat", "nl", "sed"]);

/** Commands that may share a list with reads: they change nothing and the research tools don't replace them. */
const NEUTRAL = new Set(["echo", "printf", "pwd", "true", "wc"]);
const NEUTRAL_GIT = new Set(["status", "diff", "log", "show", "blame"]);

/** `find` flags that run or delete something instead of only listing. */
const FIND_ACTIONS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"]);

/** Redirects that only discard or merge output. */
const QUIET_REDIRECT = /^(?:2>\/dev\/null|>\/dev\/null|2>&1)(?=$|[\s;|&])/u;

const inside = (root: string, target: string): boolean => {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** One command of a list; `piped`: it reads the output of the command before it. */
interface Step {
	words: string[];
	piped: boolean;
}

/**
 * `command` as its simple commands, split at unquoted `;`, `&&`, `||`, `|` and newlines. Undefined when the shell would
 * do more than run them: a substitution, variable, subshell, background job, comment, home path or a redirect that writes.
 * Unlike the file guard's `chain`, this only decides whether to offer a hint, so it accepts globs and escaped patterns.
 */
function stepsOf(command: string): Step[] | undefined {
	const steps: Step[] = [];
	let words: string[] = [];
	let word: string | undefined;
	let piped = false;
	const endWord = () => {
		if (word !== undefined) words.push(word);
		word = undefined;
	};
	const endStep = (nextPiped: boolean) => {
		endWord();
		if (words.length > 0) steps.push({ words, piped });
		words = [];
		piped = nextPiped;
	};
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];
		if (char === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return undefined;
			word = (word ?? "") + command.slice(i + 1, end);
			i = end;
		} else if (char === '"') {
			word ??= "";
			for (i++; command[i] !== '"'; i++) {
				if (i >= command.length || command[i] === "`") return undefined;
				if (command[i] === "$" && /[\w{(@*#?!$-]/u.test(command[i + 1] ?? "")) return undefined;
				if (command[i] === "\\") i++;
				word += command[i];
			}
		} else if (char === "\\") {
			if (next !== "\n") word = (word ?? "") + (next ?? "");
			i++;
		} else if (word === undefined && QUIET_REDIRECT.test(command.slice(i))) {
			i += (QUIET_REDIRECT.exec(command.slice(i))?.[0].length ?? 1) - 1;
		} else if (char === " " || char === "\t") {
			endWord();
		} else if (char === ";" || char === "\n" || (char === "&" && next === "&") || (char === "|" && next === "|")) {
			if (char === "&" || char === "|") i++;
			endStep(false);
		} else if (char === "|") {
			if (next === "&") return undefined;
			endStep(true);
		} else if (/[&<>()$`]/u.test(char) || (word === undefined && (char === "#" || char === "~"))) {
			return undefined;
		} else {
			word = (word ?? "") + char;
		}
	}
	endStep(false);
	return steps;
}

/** The role for this one read, or undefined when it is not a read that stays under `root`. */
function readerFor(words: readonly string[], directory: string, root: string): ReadRole | undefined {
	const [name, ...args] = words;
	if (!name) return undefined;
	const reader = READ_TOOL[name];
	if (!reader) return undefined;
	if (name === "sed" && args[0] !== "-n") return undefined;
	if (name === "find" && args.some((arg) => FIND_ACTIONS.has(arg))) return undefined;
	// A word that names a path elsewhere can't be read through the workspace tools; a flag or pattern resolves inside.
	const leaves = args.some(
		(arg) => !arg.startsWith("-") && arg !== "/dev/null" && !inside(root, path.resolve(directory, arg)),
	);
	return leaves ? undefined : reader;
}

const isFilter = ([name, ...args]: readonly string[]): boolean => {
	if (!name || !FILTERS.has(name)) return false;
	if (name === "sed") return args[0] === "-n";
	return name !== "sort" || !args.some((arg) => arg.startsWith("-o") || arg.startsWith("--output"));
};

const isNeutral = ([name, subcommand]: readonly string[]): boolean =>
	NEUTRAL.has(name ?? "") || (name === "git" && NEUTRAL_GIT.has(subcommand ?? ""));

/**
 * The research role a command could have used, when all it does is read this workspace: at least one `rg`, `grep`,
 * `find`, `ls`, `cat`, `head`, `tail`, `nl` or `sed -n`, whose output may be piped through filters that narrow it, joined
 * with `cd` steps that stay inside and commands that change nothing (`echo`, `wc`, `git diff` and the like). Any other
 * command, such as a build, a script or `sed -i`, means the shell is doing work those tools can't: no reader.
 */
export function codeReadTool(command: string, cwd: string): ReadRole | undefined {
	const steps = stepsOf(command);
	if (!steps) return undefined;
	let directory = cwd;
	let reader: ReadRole | undefined;
	for (const { words, piped } of steps) {
		if (piped) {
			if (!isFilter(words)) return undefined;
		} else if (words[0] === "cd") {
			if (words.length !== 2 || !words[1]) return undefined;
			directory = path.resolve(directory, words[1]);
			if (!inside(cwd, directory)) return undefined;
		} else if (words[0] === "set" && words[1] === "-o" && words[2] === "pipefail") {
			// The shell option the tool's callers prepend; it reads nothing and changes no file.
		} else if (!isNeutral(words)) {
			const found = readerFor(words, directory, cwd);
			if (!found) return undefined;
			reader ??= found;
		}
	}
	return reader;
}

/** The declared research tools of `role`, from the research server's roles; empty without one. */
function researchTools(role: ReadRole, active: readonly string[]): string[] {
	const research = currentToolRoles().research;
	if (!research) return [];
	return (role === "reader" ? [research.reader] : research.search).filter((tool) => active.includes(tool));
}

const hintText = (tools: readonly string[]): string =>
	`Hint: for code reads like this, use ${tools.map((tool) => `\`${tool}\``).join(" or ")}. Keep bash for builds, tests, scripts and git.`;

/**
 * One line for a tool result after a successful read, at most `READ_HINT_LIMIT` times per session and only while the
 * research server's tools for that read (by their roles) are declared. It lands in the conversation, never in the cached
 * prompt, and it never blocks the read.
 */
export function createReadHint(
	active: () => readonly string[],
): (command: string, cwd: string, session: string) => string | undefined {
	let current = "";
	let given = 0;
	return (command, cwd, session) => {
		if (session !== current) {
			current = session;
			given = 0;
		}
		if (given >= READ_HINT_LIMIT) return undefined;
		const role = codeReadTool(command, cwd);
		const tools = role ? researchTools(role, active()) : [];
		if (tools.length === 0) return undefined;
		given += 1;
		return hintText(tools);
	};
}
