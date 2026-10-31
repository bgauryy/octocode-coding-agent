/** A field's doc comment and the field name that follows it, on one line (docs are single-line; a doc holds no `/*`). */
const DOCUMENTED_FIELD = /\/\*\* ((?:(?!\/\*)[^\n])+?) \*\/ ("?[\w$-]+"?\??:)/g;

/**
 * Removes a field's doc where the same field name already has that exact doc earlier in the text, which is one
 * function's aliases and declaration: union branches repeat a field (`packageName`, `view`) with one doc each time.
 * The first occurrence keeps it, so the function still states it once.
 */
export function dedupeFieldDocs(block: string): string {
	const seen = new Set<string>();
	return block.replace(DOCUMENTED_FIELD, (whole, doc: string, field: string) => {
		const key = `${field.replace(/\??:$/, "")}\u0000${doc}`;
		if (!seen.has(key)) {
			seen.add(key);
			return whole;
		}
		return field;
	});
}
