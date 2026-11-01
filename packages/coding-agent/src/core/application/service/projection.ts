import { keepEnds, OUTPUT_CHARS } from "@octocodeai/octocode-contracts";

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
