import { isDeepStrictEqual } from "node:util";
import type { Tool } from "@octocodeai/octocode-mcp";

/** A connection's validated catalog. Reconnects still fetch before reusing matching definitions. */
export class McpCatalogCache {
	private identity: unknown;
	private tools: Tool[] = [];
	private instructions: string | undefined;

	update(
		identity: unknown,
		tools: Tool[],
		instructions: string | undefined,
	): {
		tools: Tool[];
		instructions: string | undefined;
	} {
		const sameServer = isDeepStrictEqual(this.identity, identity);
		const previous = new Map((sameServer ? this.tools : []).map((tool) => [tool.name, tool]));
		let next = tools.map((tool) => {
			const cached = previous.get(tool.name);
			return cached && isDeepStrictEqual(cached, tool) ? cached : tool;
		});
		const byName = new Map(next.map((tool) => [tool.name, tool]));
		if (
			sameServer &&
			byName.size === next.length &&
			next.length === this.tools.length &&
			this.tools.every((tool) => byName.has(tool.name))
		) {
			next = this.tools.map((tool) => byName.get(tool.name)!);
		}
		if (!sameServer || next.length !== this.tools.length || next.some((tool, index) => tool !== this.tools[index])) {
			this.tools = next;
		}
		this.identity = identity;
		this.instructions = instructions;
		return { tools: this.tools, instructions: this.instructions };
	}

	clear(): void {
		this.identity = undefined;
		this.tools = [];
		this.instructions = undefined;
	}
}
