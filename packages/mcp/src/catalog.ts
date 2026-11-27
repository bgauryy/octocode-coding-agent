import { isDeepStrictEqual } from "node:util";
import type { Tool } from "./client/index.ts";
import { visibleInstructions, visibleTool } from "./sanitize.ts";

/** A connection's validated catalog. Reconnects still fetch before reusing matching definitions. */
export class McpCatalogCache {
	private identity: unknown;
	private tools: Tool[] = [];
	private instructions: string | undefined;

	update(
		identity: unknown,
		announced: Tool[],
		announcedInstructions: string | undefined,
	): {
		tools: Tool[];
		instructions: string | undefined;
	} {
		// What the server sent is not trusted: its descriptions and instructions are shown with controls visible.
		const tools = announced.map(visibleTool);
		const instructions = visibleInstructions(announcedInstructions);
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

/**
 * The catalog one connection publishes: what its server announced, reused while unchanged. `revision` moves on every
 * change of client or catalog, so a `tools/list` answer that arrives after a newer change is dropped.
 */
export class ConnectionCatalog {
	tools: Tool[] = [];
	/** Server instructions from `initialize`, describing its tools as a group. */
	instructions: string | undefined;
	revision = 0;
	private readonly cache = new McpCatalogCache();

	/** Store what the server announced. True when the published tools or instructions changed. */
	publish(identity: unknown, tools: Tool[], instructions: string | undefined): boolean {
		const catalog = this.cache.update(identity, tools, instructions);
		if (this.tools === catalog.tools && this.instructions === catalog.instructions) return false;
		this.tools = catalog.tools;
		this.instructions = catalog.instructions;
		return true;
	}

	/** Remove the published catalog. True when there was one. */
	withdraw(): boolean {
		this.revision++;
		if (this.tools.length === 0 && this.instructions === undefined) return false;
		this.tools = [];
		this.instructions = undefined;
		return true;
	}

	/** Forget the cached definitions too, so a later connection starts fresh. */
	clear(): void {
		this.cache.clear();
	}
}
