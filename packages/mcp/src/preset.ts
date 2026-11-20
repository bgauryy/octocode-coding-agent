import type { McpServerConfig, McpServerEntry } from "./config.ts";
import type { createMcpToolDefinition } from "./tool-definition.ts";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";

export interface McpServerPreset {
	name: string;
	config?: McpServerConfig;
	prepareLaunch?: (entry: McpServerEntry, cwd: string, trusted: boolean) => McpServerEntry;
	defineTool?: typeof createMcpToolDefinition;
	/**
	 * The server's instructions stay out of the prompt while none of its tools is declared at the session's start (all
	 * on demand): its block lists the tools by name and trigger, and the instructions arrive with the `mcp` tool's read of
	 * the server or of one of its tools.
	 */
	instructionsOnDemand?: boolean;
	/** Warnings raised while preparing launches since the last call, for the host to show the user. */
	takeWarnings?: () => string[];
	/** Stops what the preset started outside its server (a proxy, say); called on session shutdown with the session's folder, so it must be idempotent. */
	dispose?: (cwd?: string) => void | Promise<void>;
}

export function findMcpPreset(
	presets: readonly McpServerPreset[] | undefined,
	name: string,
): McpServerPreset | undefined {
	return presets?.find((preset) => mcpNamespace(preset.name) === mcpNamespace(name));
}

export function presetEntries(presets: readonly McpServerPreset[]): McpServerEntry[] {
	return presets.flatMap(({ name, config }) =>
		config ? [{ name, config: structuredClone(config), source: `built-in ${name}`, scope: "default" as const }] : [],
	);
}
