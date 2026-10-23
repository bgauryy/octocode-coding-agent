import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../src/core/extensions/types.ts";
import { resolveToCwd } from "../../src/core/tools/path-utils.ts";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";

/**
 * A stand-in for the `write` tool that Octocode no longer ships. A custom tool may still use the name, so the permission
 * gate keeps classifying it as a file change; tests drive that code with this tool.
 */

const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });

export function createWriteToolDefinition(cwd: string): ToolDefinition<typeof writeSchema, undefined> {
	return {
		name: "write",
		label: "write",
		description: "Write content to a file (test fixture).",
		parameters: writeSchema,
		async execute(
			_toolCallId,
			{ path, content }: Static<typeof writeSchema>,
			_signal?: AbortSignal,
		) {
			const file = resolveToCwd(path, cwd);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, content);
			return { content: [{ type: "text", text: `Successfully wrote to ${path}` }], details: undefined };
		},
	};
}

export function createWriteTool(cwd: string): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd));
}
