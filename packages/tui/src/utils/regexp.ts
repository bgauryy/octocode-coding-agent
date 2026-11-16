/** `text` with every regular-expression metacharacter escaped, for matching it literally. */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
