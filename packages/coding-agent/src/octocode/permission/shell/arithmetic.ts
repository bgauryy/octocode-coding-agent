import type { Node } from "web-tree-sitter";

/**
 * Bash evaluates a variable named in an arithmetic context as an arithmetic expression, and an array subscript inside
 * that expression is expanded, command substitution included (bash manual, "Shell Arithmetic": "the value of a variable
 * is evaluated as an arithmetic expression when it is referenced"). So `$((x))` with `x='a[$(cmd)]'` runs `cmd`: code
 * the parse cannot read, like `eval "$x"`. A name is safe only when this line visibly gives it a number or arithmetic.
 */

/** Integers the shell itself sets. */
const SHELL_INTEGERS = new Set(["RANDOM", "SRANDOM", "LINENO", "SECONDS", "BASHPID", "PPID", "UID", "EUID", "OPTIND"]);
/** Builtins that set a variable from input or text the line does not show. */
const SETS_FROM_INPUT = /(?:^|[\s;&|(])(?:read|getopts|mapfile|readarray|printf\s+-v|source|\.)\s/;
const ARITHMETIC_TEST = /^(?:-eq|-ne|-lt|-le|-gt|-ge)$/;
const NAME = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * The text of an arithmetic context without what names no variable: nested command substitutions (the walk reads their
 * commands on its own) and number literals (`0x1F`, `16#ff`, `1e3` are not names).
 */
const withoutSubstitutions = (text: string): string =>
	text.replace(/\$\([^()]*\)|`[^`]*`/g, " ").replace(/\b\d+#[\w@]+|\b\d\w*/g, " ");

/** The arithmetic contexts in `root`: `$((…))`, `$[…]`, `((…))`, `for ((…))`, subscripts, `${s:o:l}`, `let`, `declare -i`, `[[ a -eq b ]]`. */
function contexts(root: Node): string[] {
	const found: string[] = [];
	for (const node of root.descendantsOfType([
		"arithmetic_expansion",
		"c_style_for_statement",
		"subscript",
		"test_command",
		"expansion",
		"command",
		"declaration_command",
	])) {
		if (!node) continue;
		if (node.type === "arithmetic_expansion") found.push(node.text);
		else if (node.type === "c_style_for_statement")
			found.push(node.text.slice(node.text.indexOf("(("), node.text.indexOf("))") + 2));
		else if (node.type === "subscript") found.push(node.childForFieldName("index")?.text ?? "");
		else if (node.type === "test_command") {
			if (node.text.startsWith("((")) found.push(node.text);
			// Only `[[ … ]]` evaluates `-eq` operands; `[`/`test` require integers and evaluate nothing.
			else if (node.text.startsWith("[["))
				for (const test of node.descendantsOfType("binary_expression"))
					if (test && ARITHMETIC_TEST.test(test.childForFieldName("operator")?.text ?? ""))
						found.push(`${test.childForFieldName("left")?.text ?? ""} ${test.childForFieldName("right")?.text ?? ""}`);
		} else if (node.type === "expansion") {
			// `${s:offset:length}`: everything after the first `:` that does not start a `:-`/`:=`/`:?`/`:+` operator.
			const body = node.text.slice(2, -1);
			const colon = body.indexOf(":");
			if (colon > 0 && !/^[-=?+]/.test(body.slice(colon + 1))) found.push(body.slice(colon + 1));
		} else if (node.type === "command") {
			if (node.childForFieldName("name")?.text === "let") found.push(node.text.slice(3));
		} else if (/^(?:declare|typeset|local)\s+-[a-zA-Z]*i/.test(node.text))
			for (const assignment of node.descendantsOfType("variable_assignment"))
				found.push(assignment?.childForFieldName("value")?.text ?? "");
	}
	return found;
}

/**
 * Commands whose output is a number (or digits and a file name that arithmetic rejects without evaluating a variable):
 * `date +%s`, `nproc`, `id -u`, and `wc -l` reading its input, also as the last stage of a pipeline (`ls | wc -l`).
 */
const NUMERIC_COMMAND = /^(?:date(?:\s+-u)?\s+(['"]?)\+(?:%s|%N|%\dN)+\1|nproc|id\s+-[ug]|wc\s+-[lcmw]+)$/;

/** Whether `value` is `$(…)` (bare or alone in double quotes) of one numeric command or a pipeline ending in one. */
function numericSubstitution(value: Node): boolean {
	const substitution = value.type === "string" && value.namedChildCount === 1 ? value.namedChild(0) : value;
	if (substitution?.type !== "command_substitution" || substitution.namedChildCount !== 1) return false;
	let last = substitution.namedChild(0);
	if (last?.type === "pipeline") last = last.namedChild(last.namedChildCount - 1);
	if (last?.type === "redirected_statement") last = last.childForFieldName("body");
	return last?.type === "command" && NUMERIC_COMMAND.test(last.text.trim().replace(/\s+/g, " "));
}

/** Whether an assignment's `value` is a number: a literal, arithmetic, or `$(…)` of a numeric command (`S=$(date +%s)`). */
export function numericValue(value: Node | null | undefined): boolean {
	return !!value && (value.type === "number" || value.type === "arithmetic_expansion" || numericSubstitution(value));
}

/** Names this line gives only numbers or arithmetic: `i=0`, `i=$((i+1))`, `S=$(date +%s)`, `for ((i=0; …; i++))`, `((n++))`. */
function numericNames(root: Node): Set<string> {
	const numeric = new Set<string>();
	const other = new Set<string>();
	for (const assignment of root.descendantsOfType("variable_assignment")) {
		const name = assignment?.childForFieldName("name")?.text;
		const value = assignment?.childForFieldName("value");
		if (!name) continue;
		if (numericValue(value)) numeric.add(name);
		else other.add(name);
	}
	for (const loop of root.descendantsOfType("for_statement")) {
		const name = loop?.childForFieldName("variable")?.text;
		if (!name) continue;
		const values = loop?.childrenForFieldName("value") ?? [];
		if (values.length > 0 && values.every((value) => value?.type === "number" || /^\d+$/.test(value?.text ?? "")))
			numeric.add(name);
		else other.add(name);
	}
	// Assignments inside arithmetic (`((n++))`, `i+=2` in a for header) store numbers.
	for (const text of contexts(root))
		for (const match of withoutSubstitutions(text).matchAll(/([A-Za-z_]\w*)\s*(?:\+\+|--|[-+*/%]?=(?!=))/g))
			numeric.add(match[1]);
	for (const name of other) numeric.delete(name);
	return numeric;
}

/** A variable name, alone or with a number, `@` or `*` subscript: what `-v` tests without evaluating anything. */
const PLAIN_VARIABLE = /^[A-Za-z_]\w*(?:\[(?:\d+|[@*])\])?$/;

/** The value of `text` as written when it expands nothing: a bare word, `'…'`, or `"…"` without `$`, backticks or backslashes. */
const unquoted = (text: string): string | undefined =>
	/^(?:'([^']*)'|"([^"$`\\]*)"|([^'"$`\\\s]*))$/
		.exec(text)
		?.slice(1)
		.find((part) => part !== undefined);

/**
 * The first `-v` operand of `[[ … ]]`, `[ … ]` or `test` that is not a plain variable name: bash expands and evaluates
 * a subscript in the operand, quoted or not, so `[[ -v 'a[$(cmd)]' ]]` runs `cmd`. Undefined when every operand is plain.
 */
export function hiddenVariableTest(root: Node): string | undefined {
	for (const node of root.descendantsOfType(["unary_expression", "command"])) {
		if (!node) continue;
		let operand: string | undefined;
		if (node.type === "unary_expression") {
			if (node.childForFieldName("operator")?.text !== "-v") continue;
			operand = node.namedChildren.find((child) => child?.type !== "test_operator")?.text ?? "";
		} else {
			const name = node.childForFieldName("name")?.text;
			if (name !== "[" && name !== "test") continue;
			const args = node.childrenForFieldName("argument").map((arg) => arg?.text ?? "");
			const at = args.indexOf("-v");
			if (at < 0) continue;
			operand = args[at + 1] ?? "";
		}
		if (!PLAIN_VARIABLE.test(unquoted(operand) ?? "")) return `-v ${operand}`;
	}
	return undefined;
}

/** The first arithmetic context of `root` that names a variable whose value this line does not show; undefined when none does. */
export function hiddenArithmetic(root: Node): string | undefined {
	const found = contexts(root);
	if (found.length === 0) return undefined;
	const numeric = SETS_FROM_INPUT.test(root.text) ? new Set<string>() : numericNames(root);
	return found.find((text) =>
		[...withoutSubstitutions(text).matchAll(NAME)].some(
			([name]) => !numeric.has(name) && !SHELL_INTEGERS.has(name) && !/^0[xX]/.test(name),
		),
	);
}
