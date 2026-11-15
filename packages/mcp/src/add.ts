import { Value } from "typebox/value";
import { McpAddCommandSchema, type McpAddCommand, type McpAddResult } from "@octocodeai/octocode-contracts/config";
import { mcpNamespace } from "../../common/src/mcp-names.ts";
import { listMcpFileEntries } from "./config.ts";
import { addMcpServerConfig } from "./config-write.ts";
import { globalMcpConfigPath, mcpConfigFiles, projectMcpConfigPath } from "./paths.ts";
import { validateMcpServerConfig } from "./servers.ts";

const MCP_ADDED_MESSAGE =
	"Saved, not applied. This server is off and not assigned by default. Run /reload, review it in /security (not checked/off until approved), then enable and assign it separately. No connection or sign-in was started.";

export class McpAddError extends Error {}

export interface McpAddOptions {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	existingNames?: readonly string[];
}

/** The requested names already taken (same tool namespace) by the live registry or a readable configuration file. */
export function mcpNameCollisions(requested: readonly string[], options: McpAddOptions): string[] {
	const taken = [...(options.existingNames ?? [])];
	for (const file of mcpConfigFiles(options.agentDir, options.cwd)) {
		if (file.scope === "project" && !options.projectTrusted) continue;
		taken.push(...listMcpFileEntries(file, options.cwd).entries.map((entry) => entry.name));
	}
	return requested.filter((name) => taken.some((other) => mcpNamespace(other) === mcpNamespace(name)));
}

/** Persist a new definition only: no process, connection, approval, runtime switch or settings mutation. */
export function saveMcpDefinition(command: McpAddCommand, options: McpAddOptions): McpAddResult {
	if (!Value.Check(McpAddCommandSchema, command))
		throw new McpAddError("Invalid MCP definition. Check the name and transport fields.");
	if (command.scope === "workspace" && !options.projectTrusted)
		throw new McpAddError("Trust the workspace before saving a workspace MCP definition.");
	if (command.transport === "stdio" && !command.command.trim()) throw new McpAddError("Command must not be blank.");
	const config =
		command.transport === "stdio"
			? {
					type: "stdio",
					command: command.command,
					args: command.args ?? [],
					...(command.env ? { env: command.env } : {}),
					enabled: false,
					defaultActive: false,
				}
			: {
					type: "http",
					url: command.url,
					...(command.headers ? { headers: command.headers } : {}),
					enabled: false,
					defaultActive: false,
				};
	const checked = validateMcpServerConfig(command.name, config);
	// Validator diagnostics may quote user input. The add surface only returns fixed, secret-free errors.
	if (typeof checked === "string")
		throw new McpAddError(
			"Invalid MCP name or transport configuration. Use an unambiguous name and an HTTP(S) URL or executable command.",
		);
	if (mcpNameCollisions([command.name], options).length > 0)
		throw new McpAddError("An MCP server with this name already exists. Choose another name.");
	const path =
		command.scope === "workspace" ? projectMcpConfigPath(options.cwd) : globalMcpConfigPath(options.agentDir);
	try {
		addMcpServerConfig(path, command.name, checked, { replace: false });
	} catch {
		// JSON parser and filesystem errors can contain file contents or paths; keep them write-only too.
		throw new McpAddError(
			"Could not save the MCP definition. Check that the destination is writable, valid JSON and does not already contain this name.",
		);
	}
	return { saved: true, message: MCP_ADDED_MESSAGE };
}
