import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import type { ImageContent, TextContent } from "@octocodeai/octocode-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../src/core/features/types.ts";
import { resolveToCwd } from "../../src/core/tools/path-utils.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, type TruncationResult, truncateHead } from "../../src/core/tools/truncate.ts";

/**
 * A stand-in for the `read` tool that Octocode no longer ships. Sessions and transcripts from other hosts still carry
 * `read` calls (offset/limit input, `details.truncation`, image results), and the guard, result dedupe and clearing keep
 * understanding them; tests drive that code with this tool.
 */

const readSchema = Type.Object({
	path: Type.String(),
	offset: Type.Optional(Type.Integer({ minimum: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

interface ReadDetails {
	truncation?: TruncationResult;
}

export function createReadToolDefinition(cwd: string): ToolDefinition<typeof readSchema, ReadDetails | undefined> {
	return {
		name: "read",
		label: "read",
		description: "Read the contents of a file (test fixture).",
		parameters: readSchema,
		async execute(
			_toolCallId,
			{ path, offset, limit }: Static<typeof readSchema>,
			_signal?: AbortSignal,
		) {
			const file = resolveToCwd(path, cwd);
			const buffer = await readFile(file);
			if (extname(file).toLowerCase() === ".png") {
				const content: (TextContent | ImageContent)[] = [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data: buffer.toString("base64"), mimeType: "image/png" },
				];
				return { content, details: undefined, structuredContent: "Read image file [image/png]" };
			}
			const lines = buffer.toString("utf8").split("\n");
			const start = (offset ?? 1) - 1;
			if (start >= lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
			const truncation = truncateHead(lines.slice(start, limit === undefined ? undefined : start + limit).join("\n"));
			let text = truncation.content;
			let details: ReadDetails | undefined;
			if (truncation.truncated) {
				const last = start + truncation.outputLines;
				text += `\n\n[Showing lines ${start + 1}-${last} of ${lines.length}${truncation.truncatedBy === "bytes" ? ` (${DEFAULT_MAX_BYTES / 1024}KB limit)` : ""}. Use offset=${last + 1} to continue.]`;
				details = { truncation };
			}
			return { content: [{ type: "text", text }], details, structuredContent: text };
		},
	};
}

export function createReadTool(cwd: string): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd));
}
