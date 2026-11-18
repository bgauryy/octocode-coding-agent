import { isMcpTool } from "./analyze.ts";
import type { AgentContext } from "./capture.ts";
import { systemText } from "./render.ts";

const bytes = (value: string): number => Buffer.byteLength(value);
const blocks = (text: string, pattern: RegExp): number =>
	[...text.matchAll(pattern)].reduce((sum, [block]) => sum + bytes(block), 0);

/** Bytes one agent's first request holds per layer; the layers add up to `total`. */
export interface Layers {
	/** The system prompt without the two layers below: policy, role, project instructions, environment. */
	system: number;
	/** The `<mcps>` section: each server's instructions and its tool list. */
	mcpInstructions: number;
	/** The `<skills>` and `<octocode_skills>` catalogs. */
	skills: number;
	/** Native tool declarations: name, description and parameter schema. */
	nativeTools: number;
	/** MCP tool declarations as sent (deferred ones with their description and field names). */
	mcpTools: number;
	total: number;
	/** What the FreeLlama server adds to `mcpInstructions` and `mcpTools`: none in a child. */
	freellama: number;
}

const declared = (tool: AgentContext["tools"][number]): number =>
	bytes(tool.name + tool.description + JSON.stringify(tool.parameters));

export function measureLayers(context: AgentContext): Layers {
	const text = systemText(context);
	const mcpInstructions = blocks(text, /<mcps>[\s\S]*?<\/mcps>/g);
	const skills = blocks(text, /<(?:octocode_)?skills>[\s\S]*?<\/(?:octocode_)?skills>/g);
	const sum = (tools: AgentContext["tools"]): number => tools.reduce((total, tool) => total + declared(tool), 0);
	const nativeTools = sum(context.tools.filter((tool) => !isMcpTool(tool.name)));
	const mcpTools = sum(context.tools.filter((tool) => isMcpTool(tool.name)));
	const system = bytes(text) - mcpInstructions - skills;
	const freellama =
		sum(context.tools.filter((tool) => tool.name.startsWith("mcp__freellama__"))) +
		blocks(text, /<mcp name="freellama"[\s\S]*?<\/mcp>/g);
	return {
		system,
		mcpInstructions,
		skills,
		nativeTools,
		mcpTools,
		total: system + mcpInstructions + skills + nativeTools + mcpTools,
		freellama,
	};
}
