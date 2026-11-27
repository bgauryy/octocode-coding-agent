import type { Node } from "web-tree-sitter";

/**
 * The bash grammar has no here-string after another redirection of a statement: `cat > f <<< hi` parses as
 * `> f`, an ERROR holding `<<`, and an input redirect `< hi` (`3<<< x` as a redirect with the ERROR inside). Bash reads
 * it as a here-string, which is input, not a file. These helpers let the parse readers accept that one misreading.
 */

/** Whether `node` is the ERROR the grammar leaves for the `<<` of a here-string it misread (the `<` follows at once). */
export function herestringError(node: Node): boolean {
	const next = node.nextSibling;
	return (
		node.isError &&
		node.text === "<<" &&
		next !== null &&
		next.startIndex === node.endIndex &&
		next.text.startsWith("<") &&
		(node.parent?.type === "redirected_statement" || node.parent?.type === "file_redirect")
	);
}

/** Whether a `file_redirect` is really a here-string the grammar misread: it follows the misread `<<`, or holds it. */
export function misreadHerestring(redirect: Node): boolean {
	if (redirect.type !== "file_redirect") return false;
	const before = redirect.previousSibling;
	if (before !== null && before.endIndex === redirect.startIndex && herestringError(before)) return true;
	return redirect.children.some((child) => child !== null && herestringError(child));
}

/** Whether every error or missing node in the tree under `root` is a misread here-string operator (so the parse is usable). */
export function onlyMisreadHerestrings(root: Node): boolean {
	if (!root.hasError) return true;
	const pending: Node[] = [root];
	while (pending.length > 0) {
		const node = pending.pop()!;
		if (node.isMissing) return false;
		if (node.isError) {
			if (!herestringError(node)) return false;
			continue;
		}
		if (!node.hasError) continue;
		for (const child of node.children) if (child) pending.push(child);
	}
	return true;
}
