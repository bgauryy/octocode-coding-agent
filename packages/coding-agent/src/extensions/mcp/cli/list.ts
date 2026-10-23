/** `pi mcp list` and `pi mcp tools`: connect to each server and report its state and tools. */

import { join } from "node:path";
import { APP_NAME } from "../../../config.ts";
import { DEFAULT_MCP_EXPOSURE } from "../../../core/mcp-servers.ts";
import { getMcpToolExposure, type LoadedMcpConfig } from "../config.ts";
import { formatMcpTool, type McpToolListing } from "../inspection.ts";
import type { McpOAuthCredentialStore } from "../runtime.ts";
import { createConnection, describeTransport, type McpCommandOptions } from "./shared.ts";

interface ServerReport {
	name: string;
	scope: string;
	source: string;
	/** Project `mcp.json` that overrides `enabled`, `exposure`, or `toolExposure` of this global server. */
	override?: string;
	overrideScope?: "global" | "project";
	enabled: boolean;
	exposure: string;
	transport: string;
	state: string;
	tools: string[];
	toolDetails?: McpToolListing[];
	/** Tools whose exposure differs from the server's, from `toolExposure`. */
	toolExposure?: Record<string, string>;
	/** Whether the server offers resources. They are not listed: listing every one can take long. */
	resources?: true;
	error?: string;
}

export async function list(
	loaded: LoadedMcpConfig,
	json: boolean,
	untrustedNote: string | undefined,
	options: McpCommandOptions,
	credentials: McpOAuthCredentialStore,
	log: (line: string) => void,
	inspect?: { server?: string; tool?: string },
): Promise<number> {
	const reports = await Promise.all(
		loaded.servers
			.filter((entry) => !inspect?.server || entry.name === inspect.server)
			.map(async (entry): Promise<ServerReport> => {
				const report: ServerReport = {
					name: entry.name,
					scope: entry.scope ?? "global",
					source: entry.source,
					...(entry.override ? { override: entry.override, overrideScope: entry.overrideScope ?? "project" } : {}),
					enabled: entry.config.enabled !== false,
					exposure: entry.config.exposure ?? DEFAULT_MCP_EXPOSURE,
					transport: describeTransport(entry),
					state: "disabled",
					tools: [],
				};
				if (!report.enabled) return report;
				const connection = createConnection(entry, options, credentials);
				try {
					await connection.getClient();
				} catch {
					// The connection records the state and error.
				}
				report.state = connection.state;
				report.tools = connection.tools.map((tool) => tool.name);
				if (inspect)
					report.toolDetails = connection.tools
						.filter((tool) => !inspect.tool || tool.name === inspect.tool)
						.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
							exposure: getMcpToolExposure(entry.config, tool.name, entry.name),
						}));
				const overrides = connection.tools.flatMap((tool) => {
					const exposure = getMcpToolExposure(entry.config, tool.name, entry.name);
					return exposure === report.exposure ? [] : [[tool.name, exposure] as const];
				});
				if (overrides.length > 0) report.toolExposure = Object.fromEntries(overrides);
				if (connection.hasResources) report.resources = true;
				if (connection.state !== "connected" && connection.error) report.error = connection.error;
				await connection.close();
				return report;
			}),
	);
	const missingTool =
		inspect?.tool && !reports.some((report) => report.toolDetails?.length)
			? `No available tool named "${inspect.tool}" on MCP server "${inspect.server}".`
			: undefined;
	const errors = [...loaded.errors, ...(missingTool ? [missingTool] : [])];
	const failed = errors.length > 0 || reports.some((report) => report.enabled && report.state !== "connected");

	if (json) {
		log(JSON.stringify({ servers: reports, errors, ...(untrustedNote ? { note: untrustedNote } : {}) }, null, 2));
		return failed ? 1 : 0;
	}
	if (reports.length === 0 && loaded.errors.length === 0) {
		log(`No MCP servers configured. Add them to ${join(options.agentDir, "mcp.json")} or .octocode/mcp.json.`);
	}
	for (const report of reports) {
		const state =
			report.state === "connected"
				? `connected, ${report.tools.length} tool${report.tools.length === 1 ? "" : "s"}`
				: report.state === "needs-auth"
					? "needs sign-in"
					: report.state;
		log(`${report.name}: ${state} (${report.exposure}, ${report.scope}) · ${report.enabled ? "enabled" : "disabled"}`);
		log(`  ${report.transport}`);
		log(`  source: ${report.source}`);
		if (report.override) log(`  ${report.overrideScope ?? "project"} override: ${report.override}`);
		if (report.state === "needs-auth") log(`  sign in with: ${APP_NAME} mcp login ${report.name}`);
		if (inspect && report.toolDetails?.length) {
			for (const tool of report.toolDetails) log(`  ${formatMcpTool(tool, !!inspect.tool).split("\n").join("\n  ")}`);
		} else if (report.tools.length > 0) {
			const tools = report.tools.map((tool) => {
				const exposure = report.toolExposure?.[tool];
				return exposure ? `${tool} [${exposure}]` : tool;
			});
			log(`  tools: ${tools.join(", ")}`);
		}
		if (report.resources) log("  offers resources");
		if (report.error) log(`  ${report.error.split("\n").join("\n  ")}`);
	}
	for (const configError of loaded.errors) log(`config error: ${configError}`);
	if (missingTool) log(missingTool);
	if (untrustedNote) log(untrustedNote);
	return failed ? 1 : 0;
}
