import type { ExtensionAPI } from "../core/extensions/index.ts";
import { getMcpSessionStatus } from "../../../mcp/src/status.ts";
import { type Subcommand, say } from "./shared/commands.ts";

/** `/status`: the loaded skills and each MCP server's connection status. */
export function statusCommand(api: ExtensionAPI): Subcommand {
	return {
		description: "status — list loaded skills and MCP connection status",
		dialog: "interaction",
		handler: async (_args, ctx) => {
			const skills = api
				.getCommands()
				.filter((command) => command.source === "skill")
				.sort((a, b) => a.name.localeCompare(b.name));
			const servers = getMcpSessionStatus(api.events);
			say(
				ctx,
				[
					`Skills (${skills.length})`,
					...(skills.length ? skills.map((skill) => `  ${skill.name} — ${skill.sourceInfo.path}`) : ["  none"]),
					`MCPs (${servers.length})`,
					...(servers.length
						? servers.map(
								(server) =>
									`  ${server.name}: ${server.enabled ? server.state : "disabled"}; ${server.exposure}; ${server.toolCount} tools — ${server.source}`,
							)
						: ["  none"]),
					"Configure servers with /mcp.",
				].join("\n"),
			);
		},
	};
}
