/** The block text `McpPresentation.describe` gives the tools it describes in full, in either presentation mode. */

import type { Tool as McpTool } from "../client/index.ts";
import { selectTools } from "../compact/index.ts";
import { shownDescription } from "./contract.ts";
import { jsonContract, jsonToolBlock } from "./json-block.ts";
import type { GeneratedServer } from "./types.ts";

/**
 * `declared` mode: the block holds the server's instructions only; the tools' descriptions and schemas are in their
 * declarations. The bytes are what the instructions and those declarations cost, for an `auto:<bytes>` budget.
 */
export function declaredContract(
	generated: GeneratedServer,
	tools: readonly string[],
	instructions: string | undefined,
): { file: undefined; text: string; bytes: number } {
	const text = instructions?.trim() ?? "";
	const declarations = tools.map((tool) => {
		const offered = generated.tools.get(tool) as McpTool;
		return Buffer.byteLength(`${shownDescription(offered) ?? ""}${JSON.stringify(offered.inputSchema)}`);
	});
	return { file: undefined, text, bytes: declarations.reduce((sum, size) => sum + size, Buffer.byteLength(text)) };
}

/**
 * The block text of the given tools: the file of those it renders faithfully (its header carries the instructions),
 * then the others in plain form. Empty text without either.
 */
export function contractText(
	generated: GeneratedServer,
	tools: readonly string[],
	instructions: string | undefined,
): { file: string | undefined; text: string } {
	const faithful = tools.filter((tool) => generated.blocks.has(tool));
	const plain = tools.filter((tool) => !generated.blocks.has(tool));
	const file =
		faithful.length > 0
			? selectTools(
					generated.text,
					faithful.map((tool) => generated.functions.get(tool) ?? tool),
				).trimEnd()
			: undefined;
	const plainBlocks = plain.map((tool) =>
		jsonToolBlock(generated.calls.get(tool) ?? tool, generated.tools.get(tool) as McpTool),
	);
	const text = file
		? [file, ...plainBlocks].join("\n")
		: plainBlocks.length > 0
			? jsonContract(generated.callName, instructions, plainBlocks)
			: "";
	return { file, text };
}
