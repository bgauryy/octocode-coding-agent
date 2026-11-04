import { existsSync } from "node:fs";
import type { Tool } from "./client/index.ts";
import { globalMcpConfigPath, globalMcpConfigPaths, projectMcpConfigPaths, projectMcpConfigPath } from "./paths.ts";
import type { McpServerEntry } from "./config.ts";
import { type McpExposure } from "./servers.ts";
import { isEnabled, type McpServer } from "./server.ts";

/** What `toolCatalog` reads of the extension state, so inspection does not depend on the state module. */
interface McpToolCatalogSource {
	findServer(name: string): McpServer | undefined;
	toolExposure(entry: McpServerEntry, tool: string): McpExposure;
	/** Registered tool name to the `<server>\0<tool>` it was assigned to. */
	toolOwners?: ReadonlyMap<string, string>;
}

export type McpToolListing = Pick<Tool, "name" | "description" | "inputSchema" | "outputSchema"> & {
	exposure: McpExposure;
	/** The name the model calls the tool by (`mcp__<server>__<tool>`), once registered. */
	callName?: string;
};

export function formatMcpTool(tool: McpToolListing, schema = false): string {
	return [
		`${tool.name} [${tool.exposure}]${tool.description ? ` — ${schema ? tool.description : tool.description.split("\n", 1)[0]}` : ""}`,
		...(schema ? [`Input schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`] : []),
		...(schema && tool.outputSchema ? [`Output schema:\n${JSON.stringify(tool.outputSchema, null, 2)}`] : []),
	].join("\n");
}

/** Configuration locations only; inspecting them never connects a server or reads credentials. */
export function getMcpConfigLocations(agentDir: string, cwd: string, projectTrusted: boolean) {
	const globalWrite = globalMcpConfigPath(agentDir);
	const projectWrite = projectMcpConfigPath(cwd);
	return {
		globalWrite,
		projectWrite,
		projectTrusted,
		files: [
			...globalMcpConfigPaths(agentDir).map((path) => ({
				path,
				scope: "global" as const,
				ignored: false,
				exists: existsSync(path),
			})),
			...projectMcpConfigPaths(cwd).map((path) => ({
				path,
				scope: "project" as const,
				ignored: !projectTrusted,
				exists: existsSync(path),
			})),
		],
	};
}

export function formatMcpConfigLocations(locations: ReturnType<typeof getMcpConfigLocations>): string {
	return [
		`Global configuration: ${locations.globalWrite}`,
		`Workspace configuration: ${locations.projectWrite}${locations.projectTrusted ? "" : " (not loaded: project is untrusted)"}`,
		"Read order (later entries override earlier ones):",
		...locations.files.map(
			(file) =>
				`  ${file.scope}: ${file.path} (${file.exists ? "exists" : "not present"}${file.ignored ? "; ignored until trusted" : ""})`,
		),
		"Enable/disable/exposure updates the effective override when one exists; otherwise global changes save to the global file. --local writes a trusted workspace override. Existing project definitions are updated in place.",
		"Enabled defaults to true; exposure defaults to direct. Use /mcp tools to inspect session tools and /reload after editing files.",
	].join("\n");
}

export function toolCatalog(state: McpToolCatalogSource, name: string): McpToolListing[] {
	const server = state.findServer(name);
	if (!server || server.connection?.state !== "connected" || !isEnabled(server)) return [];
	const calls = new Map([...(state.toolOwners ?? [])].map(([call, owner]) => [owner, call]));
	return server.connection.tools.map((tool) => {
		const callName = calls.get(`${server.entry.name}\0${tool.name}`);
		return { ...tool, exposure: state.toolExposure(server.entry, tool.name), ...(callName ? { callName } : {}) };
	});
}

/** The server's own instructions from its current connection, which the `mcp` tool resends on request. */
export function serverInstructions(state: McpToolCatalogSource, name: string): string | undefined {
	const server = state.findServer(name);
	return server?.connection?.state === "connected" ? server.connection.instructions?.trim() || undefined : undefined;
}
