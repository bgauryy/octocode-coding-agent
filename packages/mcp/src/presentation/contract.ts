/** What a server's description in the prompt says, and when it changes: instructions, and each tool's description and schemas. */

import { isDeepStrictEqual } from "node:util";
import type { Tool as McpTool } from "../client/index.ts";

interface ContractOf {
	instructions: string | undefined;
	tools: ReadonlyMap<string, McpTool>;
}

interface CatalogOf extends ContractOf {
	toolNames: Readonly<Record<string, string>>;
}

export const sameCatalog = (
	generated: CatalogOf,
	instructions: string | undefined,
	tools: readonly McpTool[],
	toolNames: Readonly<Record<string, string>>,
) =>
	generated.instructions === instructions &&
	isDeepStrictEqual(generated.toolNames, toolNames) &&
	generated.tools.size === tools.length &&
	tools.every((tool) => generated.tools.get(tool.name) === tool);

/** The text the block shows as a tool's description: its own, else its title (`jsonToolBlock`). */
export const shownDescription = (tool: McpTool) => (tool.description?.trim() ? tool.description : tool.title?.trim());

/**
 * What the block says of a tool: its description and schemas. Other fields the catalog keeps (`title` beside a
 * description, `execution`) are not part of it, so they neither renew the block nor undo a thin declaration.
 */
export const sameContract = (left: McpTool, right: McpTool) =>
	left === right ||
	(shownDescription(left) === shownDescription(right) &&
		isDeepStrictEqual(left.inputSchema, right.inputSchema) &&
		isDeepStrictEqual(left.outputSchema, right.outputSchema));

/**
 * Whether the latest catalog changes what the block says: the server's instructions, or the description or schemas
 * of a tool it describes that the server still offers. A tool the server no longer offers or one it newly offers is
 * not a change of the block (the status names the first, the second is declared in full), nor is a reconnect, whose
 * catalog keeps the same tools (`McpCatalogCache`).
 */
export const changedContract = (described: ContractOf, latest: ContractOf, tools: ReadonlySet<string>) =>
	described !== latest &&
	((described.instructions ?? "") !== (latest.instructions ?? "") ||
		[...tools].some((name) => {
			const before = described.tools.get(name);
			const now = latest.tools.get(name);
			return before !== undefined && now !== undefined && !sameContract(before, now);
		}));
