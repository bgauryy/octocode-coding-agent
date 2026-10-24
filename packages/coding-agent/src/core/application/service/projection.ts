/** Characters of tool output a frame carries. */
export const OUTPUT_CHARS = 16_000;
const HEAD_CHARS = 4_000;
/**
 * Long output keeps its start (results often open with a summary: a page title, a match count) and its end (where
 * commands report failures), joined by a marker that says how much was left out.
 */
export function keepEnds(text: string, max: number): string {
	if (text.length <= max) return text;
	const marker = (omitted: number) => `\n… [${omitted} characters omitted] …\n`;
	const tail = max - HEAD_CHARS - marker(text.length).length;
	return `${text.slice(0, HEAD_CHARS)}${marker(text.length - HEAD_CHARS - tail)}${text.slice(-tail)}`;
}

/** Text blocks of a tool result (or its string content), shortened to what a frame carries. */
export function toolResultText(value: unknown): string {
	if (value && typeof value === "object" && "content" in value && typeof value.content === "string")
		return keepEnds(value.content, OUTPUT_CHARS);
	if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return "";
	const text = value.content
		.filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
	return keepEnds(text, OUTPUT_CHARS);
}

export function queuePreview(values: string[]): string[] {
	return values
		.slice(-10)
		.map((text) => (text.length > 1000 ? `${text.slice(0, 1000)} [Queue preview shortened]` : text));
}
