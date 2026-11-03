import type { Node } from "web-tree-sitter";

/**
 * Variables a command line gives a plain literal before using them (`D=/abs/scratch; echo x > $D/a.log`), so a write
 * target spelled through one names a known path. Each bash call runs in a new shell, so a value the line does not set
 * is unknown; only the simplest case is read, and anything that could change or hide the value leaves the name unknown:
 * - the name is assigned exactly once in the line, as a statement of its own (not `D=x cmd`, which sets it for one
 *   command), outside any subshell, group, loop, condition, function or pipeline, not on the right of `||` and not in
 *   the background (`&`);
 * - the value is one literal word of plain path characters (no expansion, space, glob or `~`), so it reads the same
 *   quoted or not;
 * - no builtin in the line can set variables from input or text (`read`, `declare`, `export`, `unset`, `eval`,
 *   `source`, `printf -v`…), and no loop, arithmetic or `${D:=…}` names it;
 * - the use comes after the assignment in the text.
 */

const PLAIN_VALUE = /^[A-Za-z0-9_./+:,@%=-]+$/;
const NAME = /^[A-Za-z_]\w*$/;
/** Builtins that can set any variable from input, text the line does not show, or another file. */
const SETS_VARIABLES = new Set([
	"read",
	"getopts",
	"mapfile",
	"readarray",
	"printf",
	"unset",
	"declare",
	"typeset",
	"local",
	"export",
	"readonly",
	"source",
	".",
	"eval",
	"let",
]);

/** A variable's literal value and where its assignment ends: only a use after that sees it. */
export type LiteralVariables = Map<string, { value: string; end: number }>;

/** Whether `node` runs every time the line reaches its place in the top-level sequence. */
function unconditional(node: Node): boolean {
	for (let at: Node = node; at.parent; at = at.parent) {
		if (at.nextSibling?.type === "&") return false;
		const parent: Node = at.parent;
		if (parent.type === "program") return true;
		// The grammar hangs a redirect on the whole list (`D=x && f > out`): the list still runs as written.
		if (parent.type === "redirected_statement" && parent.childForFieldName("body")?.id === at.id) continue;
		if (parent.type !== "list") return false;
		const operator = parent.children.find((child) => child && !child.isNamed)?.type;
		if (operator === "||" && parent.namedChild(0)?.id !== at.id) return false;
	}
	return false;
}

/** The variables of `root` that hold one known literal wherever they are used after their assignment. */
export function literalVariables(root: Node, word: (node: Node) => string | undefined): LiteralVariables {
	const found: LiteralVariables = new Map();
	if (!root.text.includes("$")) return found;
	for (const node of root.descendantsOfType(["declaration_command", "unset_command"])) if (node) return found;
	for (const command of root.descendantsOfType("command")) {
		const name = command?.childForFieldName("name");
		if (name && SETS_VARIABLES.has(word(name) ?? "")) return found;
	}
	const blocked = new Set<string>();
	for (const loop of root.descendantsOfType("for_statement")) {
		const variable = loop?.childForFieldName("variable")?.text;
		if (variable) blocked.add(variable);
	}
	for (const node of root.descendantsOfType(["arithmetic_expansion", "c_style_for_statement", "test_command"]))
		if (node && (node.type !== "test_command" || node.text.startsWith("((")))
			for (const [name] of node.text.matchAll(/[A-Za-z_]\w*/g)) blocked.add(name);
	for (const node of root.descendantsOfType("expansion")) {
		const assigned = /^\$\{([A-Za-z_]\w*):?=/.exec(node?.text ?? "");
		if (assigned) blocked.add(assigned[1]);
	}
	const assignments = new Map<string, Node[]>();
	for (const assignment of root.descendantsOfType("variable_assignment")) {
		const name = assignment?.childForFieldName("name")?.text;
		if (assignment && name) assignments.set(name, [...(assignments.get(name) ?? []), assignment]);
	}
	for (const [name, [assignment, ...more]] of assignments) {
		if (more.length > 0 || blocked.has(name) || !NAME.test(name) || assignment.text.includes("+=")) continue;
		if (!unconditional(assignment)) continue;
		const valueNode = assignment.childForFieldName("value");
		const value = valueNode ? word(valueNode) : undefined;
		if (value !== undefined && PLAIN_VALUE.test(value)) found.set(name, { value, end: assignment.endIndex });
	}
	return found;
}

const BRACES = /(?<!\\)\{[^{}]*(?:,|\.\.)[^{}]*\}/;
/** Backslash escapes inside double quotes: only `$`, backtick, `"`, `\` and a newline are escaped. */
const unescape = (text: string): string =>
	text.replace(/\\([$`"\\]|\r?\n)/g, (_match, escaped: string) => (escaped.endsWith("\n") ? "" : escaped));

/** The value of `$NAME` or `${NAME}` at `node`, when `variables` knows it there. */
function expanded(node: Node, variables: LiteralVariables): string | undefined {
	const name = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(node.text);
	const known = name ? variables.get(name[1] ?? name[2]) : undefined;
	return known && known.end <= node.startIndex ? known.value : undefined;
}

/**
 * A word's value as `word` reads it, or, failing that, with each `$NAME`/`${NAME}` that `variables` knows replaced by its
 * literal (bare, glued to other text, or inside double quotes); undefined when any other part is dynamic.
 */
export function resolvedWord(
	node: Node,
	variables: LiteralVariables,
	word: (node: Node) => string | undefined,
): string | undefined {
	const value = word(node);
	if (value !== undefined || variables.size === 0) return value;
	switch (node.type) {
		case "simple_expansion":
		case "expansion":
			return expanded(node, variables);
		case "concatenation": {
			if (BRACES.test(node.text)) return undefined;
			const parts = node.namedChildren.map((child) => (child ? resolvedWord(child, variables, word) : undefined));
			return parts.every((part) => part !== undefined) ? parts.join("") : undefined;
		}
		case "string": {
			// A `$"…"` (translated) string keeps its `$` outside the node: `word` already refused it, and so does this.
			const before = node.previousSibling;
			if (before && !before.isNamed && before.type === "$" && before.endIndex === node.startIndex) return undefined;
			let out = "";
			let from = node.startIndex + 1;
			for (const child of node.namedChildren) {
				if (!child || child.type === "string_content" || child.type === "escape_sequence") continue;
				const part =
					child.type === "simple_expansion" || child.type === "expansion" ? expanded(child, variables) : undefined;
				if (part === undefined) return undefined;
				out += unescape(node.text.slice(from - node.startIndex, child.startIndex - node.startIndex)) + part;
				from = child.endIndex;
			}
			return out + unescape(node.text.slice(from - node.startIndex, -1));
		}
		default:
			return undefined;
	}
}
