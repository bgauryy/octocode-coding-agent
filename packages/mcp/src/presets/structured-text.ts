import type { CallToolResult } from "../client/index.ts";

/**
 * A preset server (browser, desktop) acknowledges a call with a short text ("OK") and returns its evidence (flow steps, failures,
 * captures, element tokens and `next.*` continuations) only in `structuredContent`. The model reads text, so the evidence follows the
 * acknowledgement as compact JSON. A text block that already carries the same JSON (the server's error envelope) is
 * left as it is.
 */
export function withStructuredText(result: CallToolResult): CallToolResult {
	if (result.structuredContent === undefined) return result;
	const json = JSON.stringify(result.structuredContent);
	const content = result.content ?? [];
	if (content.some((block) => block.type === "text" && block.text.includes(json))) return result;
	const ack = content
		.flatMap((block) => (block.type === "text" ? [block.text.trim()] : []))
		.filter(Boolean)
		.join("\n");
	return {
		...result,
		content: [
			...content.filter((block) => block.type !== "text"),
			{ type: "text", text: ack ? `${ack}\n${json}` : json },
		],
	};
}
