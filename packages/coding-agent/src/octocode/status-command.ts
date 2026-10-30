import type { ExtensionAPI } from "../core/extensions/index.ts";
import { getMcpSessionStatus } from "../../../mcp/src/status.ts";
import { type Subcommand, say } from "./shared/commands.ts";

/** `/status`: one message with the session summary, the loaded skills and each MCP server's connection status. */
export function statusCommand(api: ExtensionAPI, summary: () => string): Subcommand {
	return {
		description: "status — session summary, loaded skills and MCP connection status",
		dialog: "interaction",
		handler: async (args, ctx) => {
			if (args.trim()) return say(ctx, "Usage: /status", "warning");
			const skills = api
				.getCommands()
				.filter((command) => command.source === "skill")
				.sort((a, b) => a.name.localeCompare(b.name));
			const servers = getMcpSessionStatus(api.events);
			say(
				ctx,
				[
					summary(),
					"",
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
