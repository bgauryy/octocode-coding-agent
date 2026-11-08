import { builtinDescription } from "../core/slash-commands.ts";
import type { ExtensionAPI } from "../core/features/index.ts";
import { getMcpSessionStatus } from "../../../mcp/src/status.ts";
import { computeSessionStats } from "../core/session-stats.ts";
import { bypassMergeLine } from "./permission/ask/text.ts";
import type { PermissionMode } from "./permission/mode.ts";
import { type Subcommand, say } from "./shared/commands.ts";
import { formatSessionReport } from "./shared/session-report.ts";

/**
 * `/status`: one message with the session summary, what bypass mode does with merges (in `permission`'s bypass mode), the loaded
 * skills, each MCP server's connection status and the session's token, cache and cost totals.
 */
export function statusCommand(
	api: ExtensionAPI,
	permission: { readonly mode: PermissionMode },
	summary: () => string,
): Subcommand {
	return {
		description: builtinDescription("status"),
		dialog: "interaction",
		handler: async (args, ctx) => {
			if (args.trim()) return say(ctx, "Usage: /status", "warning");
			const skills = api
				.getCommands()
				.filter((command) => command.source === "skill")
				.sort((a, b) => a.name.localeCompare(b.name));
			const servers = getMcpSessionStatus(api.events);
			const model = ctx.model;
			const report = formatSessionReport({
				stats: computeSessionStats(ctx.sessionManager, {
					sessionFile: ctx.sessionManager.getSessionFile(),
					sessionId: ctx.sessionManager.getSessionId(),
					contextUsage: ctx.getContextUsage(),
				}),
				entries: ctx.sessionManager.getEntries(),
				prices: { getModel: (provider, id) => ctx.modelRegistry.find(provider, id) },
				selectedModelKey: `${model?.provider}/${model?.id}`,
				name: ctx.sessionManager.getSessionName(),
			});
			say(
				ctx,
				[
					summary(),
					...(permission.mode === "bypass" ? [bypassMergeLine("bypass")] : []),
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
					"",
					report,
					"",
					"Configure servers with /mcp.",
				].join("\n"),
			);
		},
	};
}
