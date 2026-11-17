import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { sessionHarnesses } from "../../discovery/vendors/prompt.ts";
import { type NormalizedBuildSystemPromptOptions, normalizeBuildSystemPromptOptions } from "../../system-prompt.ts";
import type { SessionInternals } from "../host.ts";

/** The system prompt options for the registered tools and the loaded resources of `host`'s session. */
export function buildBaseSystemPromptOptions(
	host: Pick<SessionInternals, "session" | "cwd">,
	registry: ReadonlyMap<string, AgentTool>,
	toolNames: string[],
	snippets: ReadonlyMap<string, string>,
	guidelines: ReadonlyMap<string, string[]>,
	hiddenTools: string[],
	onDemandTools: string[] = [],
): NormalizedBuildSystemPromptOptions {
	const toolSnippets: Record<string, string> = {};
	for (const name of registry.keys()) {
		const snippet = snippets.get(name);
		// Tools without a snippet are not listed.
		if (snippet) toolSnippets[name] = snippet;
	}
	const resourceLoader = host.session.resourceLoader;
	const loaderAppendSystemPrompt = resourceLoader.getAppendSystemPrompt();
	return normalizeBuildSystemPromptOptions({
		cwd: host.cwd,
		// Every harness, on or off, for the prompt's harness line (cached per discovery pass and toggles).
		harnesses: sessionHarnesses({ cwd: host.cwd, settings: host.session.settingsManager }),
		skills: resourceLoader.getSkills().skills,
		contextFiles: resourceLoader.getAgentsFiles().agentsFiles,
		customPrompt: resourceLoader.getSystemPrompt(),
		appendSystemPrompt: loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "",
		selectedTools: toolNames.filter((name) => registry.has(name)),
		hiddenTools,
		toolSnippets,
		onDemandTools: onDemandTools.filter((name) => registry.has(name)),
		toolGuidelines: Object.fromEntries(guidelines),
	});
}
