import type { Trace, TraceEvent } from "../trace.ts";
import { cannot, needTrace, type Result } from "./shared.ts";

/** `<skill>/SKILL.md` in one string: the skill is the directory that holds the file. */
const SKILL_FILE = /(?:^|[\\/])([^\\/\s"'`]+)[\\/]SKILL\.md/g;
const skillsIn = (s: string): string[] => [...s.matchAll(SKILL_FILE)].map((m) => m[1]);

function stringsIn(v: unknown): string[] {
	if (typeof v === "string") return [v];
	if (Array.isArray(v)) return v.flatMap(stringsIn);
	if (v && typeof v === "object") return Object.values(v).flatMap(stringsIn);
	return [];
}

/** Words that name a change to a file, in a tool name (`Write`, `MultiEdit`, `apply_patch`) or an operation value. */
const CHANGE_WORDS = new Set([
	"edit",
	"multiedit",
	"write",
	"patch",
	"create",
	"delete",
	"remove",
	"move",
	"rename",
	"replace",
	"insert",
	"append",
	"update",
	"overwrite",
	"save",
	"copy",
	"mkdir",
	"rm",
	"mv",
	"cp",
	"touch",
	"unlink",
	"truncate",
]);
/** Operation values that only read, such as `command: "view"` of a text editor tool. */
const READ_WORDS = new Set(["read", "view", "cat", "open", "get", "fetch", "show", "list", "search"]);
/** Argument keys whose identifier value names the operation, at any depth (a tool may nest its operations in `queries`). */
const OP_KEYS = new Set(["type", "action", "operation", "op", "mode", "command", "kind"]);
const IDENTIFIER = /^[A-Za-z_][\w-]*$/;
/** Argument keys that hold a shell command, as text or as argv. */
const SHELL_KEYS = new Set(["command", "cmd", "script"]);

const words = (name: string): string[] =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);

/** The operation values at any depth: `change` wins over `read`; undefined when the arguments name none. */
function opOf(v: unknown): "change" | "read" | undefined {
	const ops: string[] = [];
	const walk = (x: unknown): void => {
		if (!x || typeof x !== "object") return;
		for (const [k, y] of Object.entries(x)) {
			if (OP_KEYS.has(k) && typeof y === "string" && IDENTIFIER.test(y)) ops.push(...words(y));
			else walk(y);
		}
	};
	walk(v);
	if (ops.some((w) => CHANGE_WORDS.has(w))) return "change";
	return ops.some((w) => READ_WORDS.has(w)) ? "read" : undefined;
}

/** Whether a non-shell tool call changes the files it names: its operation value, else its name, says so. */
function toolChanges(e: TraceEvent): boolean {
	const op = opOf(e.args);
	if (op) return op === "change";
	return words(e.name ?? "").some((w) => CHANGE_WORDS.has(w));
}

/** Commands that change or move their file operands; their output never reaches the model as the file's text. */
const CHANGE_COMMANDS = new Set([
	"rm",
	"rmdir",
	"mv",
	"cp",
	"tee",
	"touch",
	"truncate",
	"unlink",
	"ln",
	"install",
	"dd",
	"chmod",
	"chown",
	"shred",
	"patch",
	"apply_patch",
]);
const IN_PLACE_COMMANDS = new Set(["sed", "gsed", "perl"]);
const GIT_CHANGES = new Set(["rm", "mv", "checkout", "restore", "apply"]);
/** Words before the command itself: `sudo`, `env`, `VAR=value`, control keywords. */
const PREFIX_WORDS = new Set([
	"sudo",
	"env",
	"command",
	"exec",
	"nohup",
	"time",
	"nice",
	"xargs",
	"if",
	"then",
	"do",
	"else",
	"!",
]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"]);
const SCRIPT_FLAG = /^-\w*c\w*$/i;
const REDIRECT_INTO_SKILL = />{1,2}\|?\s*["']?[^\s"'<>;|&]*SKILL\.md/;
const HEREDOC = /<<-?\s*(["']?)(\w+)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;

const base = (w: string): string => w.split(/[\\/]/).at(-1) ?? w;

/** The argv from the command word on: leading prefix words and assignments dropped. */
function commandOf(argv: string[]): string[] {
	const at = argv.findIndex((w) => !PREFIX_WORDS.has(w) && !/^\w+=/.test(w));
	return at < 0 ? [] : argv.slice(at);
}

function commandChanges(argv: string[]): boolean {
	const cmd = base(argv[0] ?? "");
	if (CHANGE_COMMANDS.has(cmd)) return true;
	if (IN_PLACE_COMMANDS.has(cmd))
		return argv.slice(1).some((w) => /^-[A-Za-z]*i/.test(w) || w.startsWith("--in-place"));
	return cmd === "git" && GIT_CHANGES.has(argv[1] ?? "");
}

/** Simple commands of a script: heredoc bodies stay with their command, then split on `;`, `&&`, `||`, `|`, `&`. */
function segments(text: string): string[] {
	const folded = text.replace(
		HEREDOC,
		(_m, q: string, tag: string, rest: string, body: string) =>
			`<<${q}${tag}${q}${rest} ${body.replace(/[\n;|&]/g, " ")}`,
	);
	return folded.split(/&&|\|\||[;\n|]|(?<![<>])&(?![>\d])/);
}

/** Words of one simple command, quotes and grouping characters removed. */
const tokens = (segment: string): string[] =>
	(segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^[$({`"']+|[)}`"';]+$/g, "")).filter(Boolean);

/** Skills a shell script reads: every simple command that names `<skill>/SKILL.md` without changing it. */
function scriptReads(text: string, depth = 0): string[] {
	return segments(text).flatMap((segment) => {
		const ws = tokens(segment);
		const argv = commandOf(ws);
		if (depth < 3 && SHELLS.has(base(argv[0] ?? "")) && SCRIPT_FLAG.test(argv[1] ?? ""))
			return scriptReads(argv.slice(2).join(" "), depth + 1);
		return REDIRECT_INTO_SKILL.test(segment) || commandChanges(argv) ? [] : ws.flatMap(skillsIn);
	});
}

/** Skills a shell argument reads; undefined when the value is an operation name, not a command. */
function shellReads(v: unknown): string[] | undefined {
	if (typeof v === "string") return IDENTIFIER.test(v) ? undefined : scriptReads(v);
	if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) return undefined;
	const argv = commandOf(v);
	if (SHELLS.has(base(argv[0] ?? "")) && SCRIPT_FLAG.test(argv[1] ?? "")) return scriptReads(argv.slice(2).join(" "));
	return commandChanges(argv) ? [] : argv.flatMap(skillsIn);
}

/**
 * The skills one event loads, in order: a `skill_load`, a Skill tool call by name, or a call that reads
 * `<skill>/SKILL.md`. A call that edits, writes, deletes or moves the file (by tool name, operation value or shell
 * command: `sed -i`, `rm`, `mv`, `tee`, a `>` redirect) is not a load.
 */
function skillsRead(e: TraceEvent): string[] {
	if (e.kind === "skill_load") return e.name ? [e.name] : [];
	if (e.kind !== "model_tool_call") return [];
	const a =
		e.args && typeof e.args === "object" && !Array.isArray(e.args) ? (e.args as Record<string, unknown>) : undefined;
	if (a && e.name !== undefined && /^skill$/i.test(e.name)) {
		const named = [a.name, a.skill, typeof a.command === "string" ? a.command.replace(/^\//, "") : undefined];
		const hits = named.filter((x): x is string => typeof x === "string" && x.length > 0);
		if (hits.length) return [...new Set(hits)];
	}
	const changes = toolChanges(e);
	if (!a) return changes ? [] : stringsIn(e.args).flatMap(skillsIn);
	const found = Object.entries(a).flatMap(([k, v]) => {
		const shell = SHELL_KEYS.has(k) ? shellReads(v) : undefined;
		if (shell) return shell;
		return changes ? [] : stringsIn(v).flatMap(skillsIn);
	});
	return [...new Set(found)];
}

/** The first skill one event loads, by the same rules as `toHaveLoadedSkill`, or undefined. */
export function skillOf(e: TraceEvent): string | undefined {
	return skillsRead(e)[0];
}

/** Every skill the trace shows loading, in first-load order; exactly the names `toHaveLoadedSkill` passes for. */
export function skillLoads(t: Trace): string[] {
	return [...new Set(t.events.flatMap(skillsRead))];
}

export const skillMatchers = {
	toHaveLoadedSkill(received: unknown, name: string): Result {
		const t: Trace = needTrace(received);
		if (!t.events.length) return cannot("no events");
		const hit = t.events.find((e) => skillsRead(e).includes(name));
		return {
			pass: hit !== undefined,
			message: () =>
				hit
					? `expected skill ${name} not to load (event #${hit.seq})`
					: `expected skill ${name} to load; no skill_load, Skill call or read of ${name}/SKILL.md found`,
		};
	},
};
