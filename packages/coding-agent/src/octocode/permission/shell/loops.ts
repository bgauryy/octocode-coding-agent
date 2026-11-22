import type { Node } from "web-tree-sitter";
import { parseBash, staticWord } from "../bash-syntax.ts";
import { SETS_VARIABLES } from "../bash-variables.ts";

/**
 * Reads a `for` loop over plain words as the commands it runs once per word (`for c in a b; do rg x > t-$c.log; done` is
 * `{ rg x > t-a.log; rg x > t-b.log; }`), so every check that reads paths sees the files the loop names, not `$c`.
 * Only a loop that cannot make the variable mean anything else is unrolled: plain literal words, a body that assigns
 * nothing, runs no builtin that sets variables, holds no here-document and names the variable only as `$c` or `${c}`.
 * Any other loop stays as written and its variable stays unknown. The block keeps a redirection or pipe on the loop
 * applying to all of it.
 */

const PLAIN_WORD = /^[A-Za-z0-9_./+:,@%-]+$/;
const NAME = /^[A-Za-z_]\w*$/;
const MAX_WORDS = 32;
const MAX_BYTES = 64 * 1024;
const MAX_PASSES = 4;

interface Edit {
	start: number;
	end: number;
	text: string;
}

/** The `$name` / `${name}` uses in `body`, or undefined when another expansion names the variable (`${c%.*}`, `$((c+1))`). */
function uses(body: Node, name: string): Node[] | undefined {
	const found: Node[] = [];
	const mention = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`);
	for (const node of body.descendantsOfType(["simple_expansion", "expansion", "arithmetic_expansion"])) {
		if (!node || !mention.test(node.text)) continue;
		if (node.type === "arithmetic_expansion") return undefined;
		if (node.text !== `$${name}` && node.text !== `\${${name}}`) return undefined;
		found.push(node);
	}
	return found;
}

/** The body of a `for` statement with each use of its variable replaced by `value`; undefined when the loop is not plain. */
function bodyFor(body: Node, from: number, to: number, uses_: Node[], value: string): string {
	let text = "";
	let at = from;
	for (const use of uses_) {
		text += body.tree.rootNode.text.slice(at, use.startIndex) + value;
		at = use.endIndex;
	}
	return text + body.tree.rootNode.text.slice(at, to);
}

/** The block that replaces `loop`, or undefined when the loop stays as written. */
function unrolled(loop: Node): string | undefined {
	const name = loop.childForFieldName("variable")?.text;
	const group = loop.childForFieldName("body");
	if (!name || !NAME.test(name) || !group) return undefined;
	const words = loop.childrenForFieldName("value").map((word) => (word ? staticWord(word) : undefined));
	if (
		words.length === 0 ||
		words.length > MAX_WORDS ||
		words.some((word) => word === undefined || !PLAIN_WORD.test(word))
	)
		return undefined;
	const open = group.children.find((child) => child?.type === "do");
	const close = group.children.find((child) => child?.type === "done");
	if (!open || !close) return undefined;
	if (
		group.descendantsOfType(["variable_assignment", "declaration_command", "unset_command", "heredoc_redirect"])
			.length > 0
	)
		return undefined;
	if (
		group
			.descendantsOfType("command")
			.some((command) => SETS_VARIABLES.has(staticWord(command.childForFieldName("name") ?? command) ?? ""))
	)
		return undefined;
	if (
		group
			.descendantsOfType(["for_statement", "c_style_for_statement"])
			.some((inner) => inner?.childForFieldName("variable")?.text === name)
	)
		return undefined;
	const named = uses(group, name);
	if (!named) return undefined;
	const copies = (words as string[]).map((word) => bodyFor(group, open.endIndex, close.startIndex, named, word));
	return `{ ${copies.join("\n")}\n}`;
}

function pass(source: string): string | undefined {
	return parseBash(source, (root) => {
		const edits: Edit[] = [];
		for (const loop of root.descendantsOfType("for_statement")) {
			// The innermost loops first: an outer loop's variable is substituted on the next pass.
			if (!loop || loop.descendantsOfType("for_statement").some((inner) => inner && inner.id !== loop.id)) continue;
			const text = unrolled(loop);
			if (text !== undefined) edits.push({ start: loop.startIndex, end: loop.endIndex, text });
		}
		if (edits.length === 0) return undefined;
		let out = "";
		let at = 0;
		for (const edit of edits.sort((a, b) => a.start - b.start)) {
			out += source.slice(at, edit.start) + edit.text;
			at = edit.end;
		}
		const next = out + source.slice(at);
		return Buffer.byteLength(next) > MAX_BYTES ? undefined : next;
	});
}

let last: { source: string; out: string } | undefined;

/**
 * `source` with its plain `for` loops written out; `source` itself when it has none, or none can be. The permission gate and
 * the write-target check unroll the same command in turn, so the last result is kept.
 */
export function unrollLoops(source: string): string {
	if (!/\bfor\b/.test(source) || !source.includes("$")) return source;
	if (last?.source === source) return last.out;
	let current = source;
	for (let at = 0; at < MAX_PASSES; at++) {
		const next = pass(current);
		if (next === undefined) break;
		current = next;
	}
	last = { source, out: current };
	return current;
}
