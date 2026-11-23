import { problemLines, readProblems } from "../core/diagnostics-log.ts";
import { builtinDescription } from "../core/slash-commands.ts";
import type { FeatureSetup } from "../core/features/index.ts";
import { mcpGroupLabel, getMcpSessionStatus } from "../../../mcp/src/api.ts";
import { computeSessionStats } from "../core/session-stats.ts";
import { bypassMergeLine } from "./permission/ask/text.ts";
import type { PermissionMode } from "./permission/mode.ts";
import { type Subcommand, say } from "./shared/commands.ts";
import { formatSessionReport } from "./shared/session-report.ts";
import { quotaLines, sessionProviders } from "./status-quota.ts";
import { workersLine } from "./status-workers.ts";

/**
 * `/status`: one message with the session summary, what bypass mode does with merges (in `permission`'s bypass mode), the loaded
 * skills, where background work runs (`status-workers.ts`), each MCP server's connection status, the quota windows of
 * the providers the session used (`status-quota.ts`), the session's token, cache and cost totals and its Cache Warming
 * section (`cacheWarmingReport`).
 */
export function statusCommand(
	api: FeatureSetup,
	permission: { readonly mode: PermissionMode },
	summary: () => string,
): Subcommand {
	return {
		description: builtinDescription("status"),
		dialog: "interaction",
		handler: async (args, ctx) => {
			if (args.trim()) return say(ctx, "Usage: /status", "warning");
			const skills = api.resources
				.getCommands()
				.filter((command) => command.source === "skill")
				.sort((a, b) => a.name.localeCompare(b.name));
			const servers = getMcpSessionStatus(api.channels);
			const model = ctx.model;
			const entries = ctx.sessionManager.getEntries();
			const quota = quotaLines(sessionProviders(entries, model?.provider));
			const report = formatSessionReport({
				stats: computeSessionStats(ctx.sessionManager, {
					sessionFile: ctx.sessionManager.getSessionFile(),
					sessionId: ctx.sessionManager.getSessionId(),
					contextUsage: ctx.getContextUsage(),
				}),
				entries,
				branch: ctx.sessionManager.getBranch(),
				prices: { getModel: (provider, id) => ctx.modelRegistry.find(provider, id) },
				selectedModelKey: `${model?.provider}/${model?.id}`,
				model: model
					? `${model.provider}/${model.id}${model.reasoning ? `:${api.models.getThinkingLevel()}` : ""}`
					: "none (/model picks one)",
				name: ctx.sessionManager.getSessionName(),
				afterCache: ctx.getCacheWarmingReport().join("\n"),
			});
			say(
				ctx,
				[
					summary(),
					...(permission.mode === "bypass" ? [bypassMergeLine("bypass")] : []),
					"",
					`Skills (${skills.length})`,
					...(skills.length
						? [`  ${skills.map((skill) => skill.name).join(", ")}`, "  Paths: /harness list <skill name>"]
						: ["  none"]),
					workersLine(),
					...problemLines(readProblems()),
					`MCPs (${servers.length})`,
					...(servers.length
						? servers.map(
								(server) =>
									`  ${server.name}: ${server.enabled ? server.state : "disabled"}; ${server.exposure}; ${server.toolCount} tools${server.group ? ` — ${mcpGroupLabel(server.group)}` : ""}`,
							)
						: ["  none · /mcp adds one"]),
					...(servers.length ? ["  Sources and tools: /harness list <server name>, /mcp tools <server>"] : []),
					...(quota.length ? ["", ...quota] : []),
					"",
					report,
				].join("\n"),
			);
		},
	};
}
