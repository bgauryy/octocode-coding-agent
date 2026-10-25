import type { McpServerConfig, McpServerEntry, McpExposure } from "./config.ts";
import type { createMcpToolDefinition } from "./tool-definition.ts";
import { mcpNamespace } from "./servers.ts";

export interface McpServerPreset {
	name: string;
	config?: McpServerConfig;
	toolExposure?: Readonly<Record<string, McpExposure>>;
	preferDeferred?: boolean;
	prepareLaunch?: (entry: McpServerEntry, cwd: string, trusted: boolean) => McpServerEntry;
	defineTool?: typeof createMcpToolDefinition;
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
