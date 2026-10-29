import type { McpServerConfig, McpServerEntry } from "./config.ts";
import type { CompactServerInput, DescriptionOverrides } from "./compact/index.ts";
import type { createMcpToolDefinition } from "./tool-definition.ts";
import { mcpNamespace } from "./servers.ts";

export interface McpServerPreset {
	name: string;
	config?: McpServerConfig;
	prepareLaunch?: (entry: McpServerEntry, cwd: string, trusted: boolean) => McpServerEntry;
	defineTool?: typeof createMcpToolDefinition;
	/**
	 * Description overrides for the server's generated file that still describe this catalog: the preset ships them per
	 * tool with the hash of the tool they were written for (`presetOverridesFor`), so changed tools get none.
	 */
	compactOverrides?: (input: CompactServerInput) => DescriptionOverrides | undefined;
	/** Stops what the preset started outside its server (a proxy, say); called on session shutdown, so it must be idempotent. */
	dispose?: () => void | Promise<void>;
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
