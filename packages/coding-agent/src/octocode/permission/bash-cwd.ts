import type { Node } from "web-tree-sitter";

/**
 * Where each part of a parsed command runs, relative to the command's own working directory, for the shapes where a
 * `cd` can be followed: a target `followableCdTarget` accepts, in a plain `&&` / `;` / newline sequence (also inside a
 * subshell). A state is the directory prefixes the part may run in (`""` is the starting directory; a prefix is spelled as
 * written, absolute or relative to it), or undefined when no prefix can be named: any other `cd` operand, `popd`, a `cd`
 * under `||`, in a loop, a condition or a group, a command that runs a `cd` of its own below it (`$(cd x; f)`,
 * `<(cd x; f)`, backticks) and a function body whenever the script moves directory at all (it runs at call time).
 *
 * `cd a && f` runs `f` in `a` alone; `cd a; f` runs it in `a` or, when the `cd` fails, where it started, so both are kept.
 *
 * `builtin cd x` and `command cd x` are read as `cd x`. Not followed: a directory change made by `source` / `.`,
 * `eval` or a `trap`.
 */
type Dirs = string[] | undefined;
interface Step {
	/** The state after the part exits successfully (what the right side of `&&` sees). */
	success: Dirs;
	/** The state after the part, whatever its exit status. */
	after: Dirs;
}

/** `BashFileTarget.uncertain` for a relative target that follows a `cd`. */
export const RELATIVE_AFTER_CD = "relative target follows cd";

const MAX_DIRS = 8;
const MAX_DEPTH = 128;
const DIRECTORY_COMMANDS = new Set(["cd", "pushd", "popd"]);
/** Builtins that run the command named after them, so `builtin cd x` and `command -p cd x` move like `cd x`. */
const COMMAND_RUNNERS = new Set(["builtin", "command"]);

/**
 * Whether `operand` of `cd` / `pushd` names the same directory for the shell and for a path check: `.` or a path that
 * starts with `/`, `./` or `~` (the home folder, as `~/x`), with no `..` component. A bare name is looked up in `CDPATH` first, so it can lead anywhere;
 * `..` is resolved by the shell on the spelling (`cd link/..` is the link's parent) but by a path check on the real
 * directories (the link target's parent), so a `..` can lead out of what the check sees. Both are left unfollowed.
 */
export const followableCdTarget = (operand: string): boolean =>
	(operand === "." ||
		operand === "~" ||
		operand.startsWith("/") ||
		operand.startsWith("./") ||
		operand.startsWith("~/")) &&
	!operand.split("/").includes("..");

/**
 * The command with each plain `cd name` spelled `cd ./name`, for a write-target check alone. `followableCdTarget` leaves a
 * bare name unfollowed because `CDPATH` may send it elsewhere; with none set, it names the same folder, and following it is
 * what shows where the write after it (`cd packages/x && t > ../../log`) lands. A `..` target, a variable, `cd -`, a `||`
 * and a loop stay unfollowed (the parse then calls the write uncertain).
 */
export function followingBareCd(command: string, env: NodeJS.ProcessEnv = process.env): string {
	if (env.CDPATH || command.includes("CDPATH")) return command;
	return command.replace(/(^|&&|;|\n|\()(\s*)cd\s+(?=[A-Za-z0-9_])/g, "$1$2cd ./");
}

/**
 * The command with each `cd <plain word>` that ends in `;` or a newline joined to what follows by `&&` instead, so a
 * failed `cd` stops the command. The rewrite is a suggestion for a refusal: the caller checks it before offering it.
 */
export const joiningCd = (command: string): string =>
	command.replace(/(^|&&|;|\n|\()(\s*cd\s+[^\s;&|()<>$`'"\\]+)[ \t]*(?:;|\n)[ \t]*/g, "$1$2 && ");

/** A word spelled from the home directory by the variable (`$HOME/x`, `"${HOME}/x"`), as the `~` path a check expands; undefined for anything else. */
const homeVariable = (text: string): string | undefined => {
	const match = /^\$(?:HOME|\{HOME\})(\/[^$`*?[\\'{}]*)?$/.exec(text.replaceAll('"', ""));
	return match ? `~${match[1] ?? ""}` : undefined;
};

const capped = (dirs: string[]): Dirs => {
	const all = [...new Set(dirs)];
	return all.length > MAX_DIRS ? undefined : all;
};
const union = (a: Dirs, b: Dirs): Dirs => (a === undefined || b === undefined ? undefined : capped([...a, ...b]));

/** `file` as seen from a prefix: absolute paths and `~` forms keep their spelling; `..` is left for the caller to follow through links. */
export const underDirectory = (dir: string, file: string): string =>
	dir === "" || file.startsWith("/") || file.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(file)
		? file
		: `${dir.endsWith("/") ? dir : `${dir}/`}${file}`;

/**
 * The directory command (`cd`, `pushd`, `popd`) a parsed command node runs and its operands, also behind `builtin` and
 * `command` (whose `-v`/`-V` only print), or undefined when it runs none. `word` reads a node's static text.
 */
export function directoryCommand(
	node: Node,
	word: (node: Node) => string | undefined,
): { name: string; operands: Node[] } | undefined {
	if (node.type !== "command") return undefined;
	const name = node.childForFieldName("name");
	let program = name ? word(name) : undefined;
	const words = node.childrenForFieldName("argument").filter((child): child is Node => child !== null);
	while (program !== undefined && COMMAND_RUNNERS.has(program)) {
		let next = words.shift();
		let option = next ? word(next) : undefined;
		while (program === "command" && option?.startsWith("-")) {
			if (/[vV]/.test(option)) return undefined;
			next = words.shift();
			option = next ? word(next) : undefined;
		}
		program = option;
	}
	return program !== undefined && DIRECTORY_COMMANDS.has(program) ? { name: program, operands: words } : undefined;
}

/**
 * The state of every node that starts a part of `root` (a program, list, command, subshell...). A node that is not a key
 * runs where its nearest keyed ancestor does; a key with an undefined value is a part whose directory is unknown.
 */
export function directoryStates(root: Node, word: (node: Node) => string | undefined): Map<number, Dirs> {
	const states = new Map<number, Dirs>();
	const unknown: Step = { success: undefined, after: undefined };
	const directoryCall = (node: Node) => directoryCommand(node, word);
	/** Whether `node` is a directory command; `containsMove`: whether it is one or has one below it. */
	const isMove = (node: Node): boolean => directoryCall(node) !== undefined;
	const containsMove = (node: Node): boolean =>
		isMove(node) || node.descendantsOfType("command").some((command) => command !== null && isMove(command));
	const anyMove = containsMove(root);
	/** The operand of a plain `cd dir` / `pushd dir`. */
	const target = (node: Node): string | undefined => {
		const call = directoryCall(node);
		if (call === undefined || !["cd", "pushd"].includes(call.name)) return undefined;
		if (node.namedChildren.some((child) => child?.type === "variable_assignment")) return undefined;
		const { operands } = call;
		const value =
			operands.length === 1 && operands[0] ? (word(operands[0]) ?? homeVariable(operands[0].text)) : undefined;
		return value !== undefined && followableCdTarget(value) ? value : undefined;
	};

	function sequence(children: Array<Node | null>, start: Dirs, depth: number): Dirs {
		let current = start;
		children.forEach((child, index) => {
			if (!child?.isNamed) return;
			const step = walk(child, current, depth);
			// `cd x &` runs in a background subshell: the directory does not change.
			if (children[index + 1]?.type !== "&") current = step.after;
		});
		return current;
	}

	function walk(node: Node, dirs: Dirs, depth: number): Step {
		states.set(node.id, dirs);
		if (dirs === undefined || depth > MAX_DEPTH) {
			states.set(node.id, undefined);
			return unknown;
		}
		const unchanged: Step = { success: dirs, after: dirs };
		switch (node.type) {
			case "command": {
				if (!isMove(node)) {
					// A substitution below the command runs its own `cd`: the command's other words still run here, so
					// its nested parts take the unknown state while what follows is unchanged.
					if (containsMove(node)) states.set(node.id, undefined);
					return unchanged;
				}
				const to = target(node);
				const success = to === undefined ? undefined : capped(dirs.map((dir) => underDirectory(dir, to)));
				return { success, after: union(dirs, success) };
			}
			case "redirected_statement": {
				const body = node.childForFieldName("body");
				return body ? walk(body, dirs, depth + 1) : unchanged;
			}
			case "list": {
				const operator = node.children.find((child) => child && !child.isNamed)?.type;
				const [left, right] = [node.namedChild(0), node.namedChild(node.namedChildCount - 1)];
				if (operator === "&&" && left && right) {
					const first = walk(left, dirs, depth + 1);
					const second = walk(right, first.success, depth + 1);
					return { success: second.success, after: union(first.after, second.after) };
				}
				if (operator === "||" && left && right && !containsMove(node)) {
					walk(left, dirs, depth + 1);
					walk(right, dirs, depth + 1);
					return unchanged;
				}
				break;
			}
			case "subshell":
				sequence(node.children, dirs, depth + 1);
				return unchanged;
			case "pipeline":
				// Each stage is its own subshell: a `cd` in one does not reach the others or what follows.
				for (const stage of node.namedChildren) if (stage) walk(stage, dirs, depth + 1);
				return unchanged;
			case "function_definition":
				// The body runs when the function is called, in the caller's directory, not where it is defined.
				if (anyMove) states.set(node.id, undefined);
				if (!containsMove(node)) return unchanged;
				break;
			default:
				if (!containsMove(node)) return unchanged;
		}
		states.set(node.id, undefined);
		return unknown;
	}

	states.set(root.id, [""]);
	sequence(root.children, [""], 0);
	return states;
}

/**
 * The state of `node`: its own entry, else its nearest keyed ancestor's; undefined when unknown. A redirect on a list
 * (`cd a && f > out`, which the grammar attaches to the whole list) belongs to the last command of the list.
 */
export function directoriesAt(states: Map<number, Dirs>, node: Node | null): string[] | undefined {
	for (let at = node; at; at = at.parent) {
		if (at.type === "file_redirect" && at.parent?.type === "redirected_statement") {
			let body = at.parent.childForFieldName("body");
			while (body?.type === "list") body = body.namedChild(body.namedChildCount - 1);
			return directoriesAt(states, body ?? at.parent);
		}
		if (states.has(at.id)) return states.get(at.id);
	}
	return undefined;
}
