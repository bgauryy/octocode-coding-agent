import { existsSync } from "node:fs";
import type { Tool } from "@octocodeai/octocode-mcp";
import {
	globalMcpConfigPath,
	globalMcpConfigPaths,
	projectMcpConfigPath,
	projectMcpConfigPaths,
} from "../../core/mcp-config-paths.ts";
import type { McpExposure } from "../../core/mcp-servers.ts";

export type McpToolListing = Pick<Tool, "name" | "description" | "inputSchema"> & { exposure: McpExposure };

export function formatMcpTool(tool: McpToolListing, schema = false): string {
	return [
		`${tool.name} [${tool.exposure}]${tool.description ? ` — ${schema ? tool.description : tool.description.split("\n", 1)[0]}` : ""}`,
		...(schema ? [`Input schema:\n${JSON.stringify(tool.inputSchema, null, 2)}`] : []),
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
		"Enabled defaults to true; exposure defaults to auto. Use /mcp tools to inspect session tools and /reload after editing files.",
	].join("\n");
}
