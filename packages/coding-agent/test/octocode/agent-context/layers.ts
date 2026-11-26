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
	/** The skill listing: the `path: description` lines at the end of the `skill` tool's description. */
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

/** Bytes of the skill listing in the `skill` tool's declaration (0 without the tool). */
export function skillListingBytes(context: AgentContext): number {
	const description = context.tools.find((tool) => tool.name === "skill")?.description ?? "";
	const at = description.indexOf(SKILL_LISTING_MARKER);
	return at < 0 ? 0 : bytes(description.slice(at + SKILL_LISTING_MARKER.length));
}

const SKILL_LISTING_MARKER = "Skills, as `path: description`:\n";

export function measureLayers(context: AgentContext): Layers {
	const text = systemText(context);
	const mcpInstructions = blocks(text, /<mcps>[\s\S]*?<\/mcps>/g);
	const skills = skillListingBytes(context);
	const sum = (tools: AgentContext["tools"]): number => tools.reduce((total, tool) => total + declared(tool), 0);
	const nativeTools = sum(context.tools.filter((tool) => !isMcpTool(tool.name))) - skills;
	const mcpTools = sum(context.tools.filter((tool) => isMcpTool(tool.name)));
	const system = bytes(text) - mcpInstructions;
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

/**
 * What Octocode itself writes into a first request: `system`, `skills` and `nativeTools` bytes, `own` their sum, and `loads`,
 * how many native tools a first use loads. The MCP servers' instructions and tool declarations are the servers' text, which
 * drifts with their releases: they are reported, never capped here.
 */
export type OwnCeilings = Pick<Layers, "system" | "skills" | "nativeTools"> & { own: number; loads: number };

/** Octocode-owned bytes of a first request, and the tools it loads on first use, leaving out every MCP tool. */
export function ownLayers(context: AgentContext): Omit<OwnCeilings, "loads"> & { loads: number } {
	const layers = measureLayers(context);
	const nativeLoads = (context.deferred ?? []).filter((tool) => !isMcpTool(tool.name)).length;
	const { system, skills, nativeTools } = layers;
	return { system, skills, nativeTools, own: system + skills + nativeTools, loads: nativeLoads };
}

/** What a first use must still load (`AgentContext.deferred`): how many tools, and the bytes their full declarations add. */
export interface Loads {
	/** Tools declared thin: the full schema arrives with a refused call or an `mcp` read. */
	deferred: number;
	/** Tools left undeclared until their first call or a load. */
	onDemand: number;
	/** Bytes the full declarations of all of them take once loaded (the thin ones' declared bytes are in `Layers`). */
	fullBytes: number;
}

export function measureLoads(context: AgentContext): Loads {
	const tools = context.deferred ?? [];
	return {
		deferred: tools.filter((tool) => tool.state === "deferred").length,
		onDemand: tools.filter((tool) => tool.state === "onDemand").length,
		fullBytes: tools.reduce((sum, tool) => sum + tool.fullBytes, 0),
	};
}
