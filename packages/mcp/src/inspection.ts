import { existsSync } from "node:fs";
import type { Tool } from "./client/index.ts";
import { hostIdentity, hostVendors } from "./host.ts";
import { globalMcpConfigPath, mcpConfigFiles, projectMcpConfigPath } from "./paths.ts";
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
	const vendorEnabled = hostVendors().vendorSwitch({ agentDir, cwd, projectTrusted });
	return {
		globalWrite,
		projectWrite,
		projectTrusted,
		files: mcpConfigFiles(agentDir, cwd).map((file) => ({
			path: file.path,
			scope: file.scope,
			vendor: file.vendor,
			...(file.claudeProject === undefined ? {} : { claudeProject: file.claudeProject }),
			switchedOff: !vendorEnabled(file.vendor, file.scope),
			ignored: file.scope === "project" && !projectTrusted,
			exists: existsSync(file.path),
		})),
	};
}

/**
 * Why project MCP files are not loaded: they exist, but the folder is untrusted. Undefined when the folder is trusted or
 * no project file exists. One sentence for the CLI and the session notice.
 */
export function untrustedProjectNote(agentDir: string, cwd: string, projectTrusted: boolean): string | undefined {
	if (projectTrusted) return undefined;
	const present = mcpConfigFiles(agentDir, cwd).filter((file) => file.scope === "project" && existsSync(file.path));
	if (present.length === 0) return undefined;
	const app = hostIdentity().appName;
	return `Project MCP configuration is ignored because the folder is not trusted. Run \`${app} trust add\` in it, or start ${app} there to trust it. Not loaded: ${present.map((file) => file.path).join(", ")}.`;
}

export function formatMcpConfigLocations(locations: ReturnType<typeof getMcpConfigLocations>): string {
	return [
		`Global configuration: ${locations.globalWrite}`,
		`Workspace configuration: ${locations.projectWrite}${locations.projectTrusted ? "" : " (not loaded: project is untrusted)"}`,
		"Read order (later entries override earlier ones):",
		...locations.files.map(
			(file) =>
				`  ${file.scope}: ${file.path}${file.claudeProject === undefined ? "" : ` projects[${JSON.stringify(file.claudeProject)}]`} (${file.exists ? "exists" : "not present"}${file.switchedOff ? `; ${file.vendor} is off (/harness enable ${file.vendor})` : ""}${file.ignored ? "; ignored until trusted" : ""})`,
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
