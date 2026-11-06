import { type CallToolResult, toLlmContent } from "./client/index.ts";
import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import type { ImageLimits } from "@octocodeai/octocode-ai/utils/vision";
import { hostOutput } from "./host.ts";
import { sanitizeJson } from "./sanitize.ts";
import { jsonText } from "./tools.ts";

/**
 * A tool result for a server whose tool presentation owns its conversion. Shared content conversion handles text and images.
 * A server bounds and pages its own output and a cut can hide the continuation inside
 * it, so text is left whole up to `hostOutput().textMaxChars` (less once the turn's `budget` is nearly used); a longer part is
 * saved whole to the session's `output/` folder and replaced by its head and tail plus the file's path. An oversized
 * image is saved and resized to `limits` (the active model's image limit, `imageLimits(ctx.model)`); the model sees the fitted image, its original path and the
 * dimension mapping (only the path if resizing fails). Server text is untrusted: terminal control
 * characters, bidi overrides and invisible characters (Unicode tags among them) are shown as visible escapes
 * (`\u{200d}`, `\r`) in every string before the model reads it or the terminal draws it, so nothing the server
 * returned disappears and nothing raw reaches the terminal. `structuredContent` is kept for tools that declare an
 * `outputSchema`: the server's own, or, when the server sends its JSON result only as one text block, that JSON parsed.
 * Oversized structured results the server sent become explicit errors with a saved JSON recovery path; a parsed one that
 * large is left out, and its text is capped and saved like any other.
 * An error result is the server's text as an error.
 */
export async function toToolResult(
	tool: string,
	received: CallToolResult,
	declaresOutput: boolean,
	limits?: ImageLimits,
): Promise<AgentToolResult<{ tool: string }>> {
	let result = received;
	const content: AgentToolResult["content"] = [];
	let outputTruncated = false;
	const sent = result.structuredContent;
	const structured = declaresOutput ? (sent ?? jsonText(result, hostOutput().textMaxChars)) : undefined;
	let structuredContent =
		structured !== undefined ? (sanitizeJson(structured) as AgentToolResult["structuredContent"]) : undefined;
	let failed = result.isError;
	if (sent !== undefined && structuredContent !== undefined) {
		const serialized = JSON.stringify(structuredContent);
		if (serialized.length > hostOutput().textMaxChars) {
			const file = hostOutput().saveFullOutput(serialized, `mcp-${tool}-structured`);
			structuredContent = undefined;
			failed = true;
			result = {
				...result,
				content: [
					{
						type: "text",
						text: file
							? `Structured result exceeds ${hostOutput().textMaxChars} characters. Full JSON: ${file}. Request a smaller page or read the saved JSON.`
							: "Structured result exceeds the output limit and could not be saved. Request a smaller page.",
					},
				],
			};
		}
	}
	const modelContent = toLlmContent(result);
	for (const part of sanitizeJson(modelContent) as ReturnType<typeof toLlmContent>) {
		if (part.type === "text") {
			const text = hostOutput().capResultText(part.text, `mcp ${tool}`);
			outputTruncated ||= text !== part.text;
			content.push({ ...part, text });
		} else if (part.type === "image") {
			content.push(...(await hostOutput().boundImagePart(part, `mcp ${tool} image`, limits ? { limits } : {})));
		} else content.push(part);
	}
	if (failed && content.length === 0) {
		content.push({ type: "text", text: `${tool} failed without a message.` });
	}
	return {
		content,
		details: { tool, ...(outputTruncated ? { outputTruncated: true } : {}) },
		...(structuredContent !== undefined ? { structuredContent } : {}),
		...(failed ? { isError: true } : {}),
	};
}
