import { homedir } from "node:os";
import { getMcpSessionStatus } from "../../../../mcp/src/api.ts";
import { getAgentDir } from "../../config.ts";
import { collectContextView } from "../../core/discovery/context-snapshot.ts";
import { formatContextText } from "../../core/discovery/context-text.ts";
import { type LoadedRef, sourceInfoLabel } from "../../core/discovery/context-view.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/features/index.ts";
import { installOctocodeDiscovery } from "./index.ts";
import { say } from "../shared/commands.ts";

/**
 * `/harness config`: the loaded context (AGENTS.md and other instruction files, skills, agents, hooks, plugins, prompts,
 * MCP servers and the rest) with where each item came from, as text, so RPC and print modes show what the startup screen
 * shows. Read-only; a change takes effect on `/reload` or a new session.
 */
export function showLoadedConfig(api: ExtensionAPI, ctx: ExtensionCommandContext): void {
	// Hooks, agents, plugins and MCP definitions register with discovery once; a mode that never ran a loader may not have.
	installOctocodeDiscovery();
	const agentDir = getAgentDir();
	const projectTrusted = ctx.isProjectTrusted();
	const loaded = ctx.getSystemPromptOptions();
	const commands = api.getCommands();
	const refs = (source: "prompt" | "skill"): LoadedRef[] =>
		commands
			.filter((command) => command.source === source)
			.map((command) => ({
				path: command.sourceInfo.path,
				name: command.name,
				label: sourceInfoLabel(command.sourceInfo),
			}));
	const view = collectContextView({
		cwd: ctx.cwd,
		agentDir,
		projectTrusted,
		settings: api.getSettings(),
		mcp: getMcpSessionStatus(api.events),
		loaded: {
			context: loaded.contextFiles?.map((file) => ({ path: file.path, label: "project" })) ?? [],
			skill: refs("skill"),
			prompt: refs("prompt"),
		},
	});
	// A terminal wraps at its width, so a long path is cut from the left to fit; other modes get the whole path.
	const width = ctx.mode === "tui" && process.stdout.columns ? process.stdout.columns - 2 : undefined;
	say(ctx, formatContextText(view, homedir(), width));
}
