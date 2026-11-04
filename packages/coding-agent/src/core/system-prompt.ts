import { BASH_TOOL, SKILL_TOOL } from "./tools/tool-names.ts";
import { isOctocodeReader, isOctocodeSearch, routesSearchToOctocode } from "../../../mcp/src/presets/octocode/names.ts";
import { isMcpToolName } from "../../../mcp/src/servers.ts";
/**
 * System prompt construction and project context loading
 */

import { getSystemMessageText } from "@octocodeai/octocode-ai";
import { dirname } from "node:path";
import { getReadmePath } from "../config.ts";
import { renderInstruction } from "./prompt-template.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";
import {
	assertSystemPromptSectionName,
	composeSystemPromptSections,
	systemPromptSectionSpec,
} from "./system-prompt-spec.ts";

export interface BuildSystemPromptOptions {
	/**
	 * Custom system prompt (`SYSTEM.md`): replaces the default preamble and leaves out the docs pointer and the default
	 * rule lines (conciseness, bash search). The tool list, tool guidelines, MCP servers, project context, skills, policy
	 * and environment stay (`system-prompt-spec.ts`).
	 */
	customPrompt?: string;
	/** Exact full prompt replacement set by a before_agent_start handler. */
	forceSystemPrompt?: string;
	/** Tools to include in prompt. Default: [bash]. */
	selectedTools?: string[];
	/**
	 * Selected tools whose declarations requests leave out (`prepareLoadout` hidden declarations).
	 * They are reachable only through another tool, so the tool list and rules leave them out too.
	 */
	hiddenTools?: string[];
	/**
	 * One line per tool keyed by tool name, from each tool's `promptSnippet` (what the tool is for, and when where that
	 * decides the choice). Rendered in the `tools` section as `- name: snippet` for declared tools that are not MCP
	 * tools, in declaration order, with or without a custom prompt.
	 */
	toolSnippets?: Record<string, string>;
	/**
	 * The one-line purpose of each MCP server whose tools are declared, keyed by tool namespace (`mcp__<server>`), from
	 * the server's own description. Rendered in the `tools` section as `- mcp__<server>__*: purpose` after the native
	 * tools, in key order, so the first list the model reads names every server. The producer (the MCP extension) sets
	 * it for servers whose `mcps` block leaves the purpose out, so each purpose is stated once.
	 */
	mcpServers?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt rules. */
	promptGuidelines?: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	appendSystemPrompt?: string;
	/**
	 * XML-wrapped prompt sections keyed by tag name. A known name (`system-prompt-spec.ts`) takes its declared place and
	 * replaces that section's default; an empty string removes the section. Other names end the session sections,
	 * before `environment` and the volatile sections.
	 */
	sections?: Record<string, string>;
	/**
	 * XML-wrapped sections that depend only on the tools and the install, such as the `mcps` section, keyed by tag name.
	 * Known names take their declared place; other names follow the known base sections in the given order, before
	 * project context, so sessions in other projects or on other days share them in the first instruction cache block.
	 */
	baseSections?: Record<string, string>;
	/** Working directory. */
	cwd: string;
	/** Platform, shell and date for the `environment` section (`currentEnvironment`); left out when absent. */
	environment?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

export type NormalizedBuildSystemPromptOptions = BuildSystemPromptOptions & {
	selectedTools: string[];
	hiddenTools: string[];
	toolSnippets: Record<string, string>;
	mcpServers: Record<string, string>;
	toolGuidelines: Record<string, string[]>;
	promptGuidelines: string[];
	appendSystemPrompt: string;
	sections: Record<string, string>;
	baseSections: Record<string, string>;
	contextFiles: Array<{ path: string; content: string }>;
	skills: Skill[];
};

/**
 * Ordered system prompt sections, keyed by name. `preamble` is untagged text; every other
 * section is wrapped in a tag of the same name so the model can match later updates to it.
 * These become `SystemMessage.sections` in the transcript.
 */
export type SystemPromptSections = Record<string, string>;

/**
 * The `environment` section (`octocode/instructions/system/environment.md`): platform and shell, today's local date and,
 * for a session other processes can reach, its process name. The last default section (custom sections follow it); a
 * new day changes only this section, and a session's name holds until `/new` or `/resume` starts another conversation.
 */
export function currentEnvironment(
	now = new Date(),
	env: NodeJS.ProcessEnv = process.env,
	processName?: string,
): string {
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const shell = env.SHELL?.split(/[\\/]/).pop() || (process.platform === "win32" ? "cmd" : "sh");
	return renderInstruction("system/environment.md", {
		platform: process.platform,
		arch: process.arch,
		shell,
		date,
		processName,
	});
}
/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? [BASH_TOOL])],
		hiddenTools: [...(input.hiddenTools ?? [])],
		toolSnippets: { ...input.toolSnippets },
		mcpServers: { ...input.mcpServers },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...input.sections },
		baseSections: { ...input.baseSections },
		cwd: input.cwd,
		environment: input.environment,
		contextFiles: (input.contextFiles ?? []).map((file) => ({ ...file })),
		skills: (input.skills ?? []).map((skill) => ({ ...skill })),
	};
}

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	const files = contextFiles.map(
		({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
	);
	return renderInstruction("system/project-context.md", { files: files.join("\n\n") });
}

function buildRules(
	selectedTools: string[],
	toolGuidelines: Record<string, string[]>,
	promptGuidelines: string[],
	includeFloor: boolean,
	bashSearch: boolean,
): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	if (bashSearch) addRule(renderInstruction("system/rules-bash.md"));

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	// The floor for sessions without Octocode's Communication policy, which says the same with more detail.
	if (includeFloor) {
		for (const rule of renderInstruction("system/rules-floor.md").split("\n")) addRule(rule);
	}
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** The skill hint's file reader: the skill tool, then Octocode, then bash; `indirect` when only reachable through another tool. */
function skillReader(selectedTools: string[], declaredTools: string[]): Parameters<typeof formatSkillsForPrompt>[1] {
	// The skill tool loads a skill by name and needs no file reader, so it comes first. Octocode ships no `read` tool.
	if (declaredTools.includes(SKILL_TOOL)) return SKILL_TOOL;
	if (declaredTools.some(isOctocodeReader)) return "octocode";
	if (declaredTools.includes(BASH_TOOL)) return "bash";
	return selectedTools.includes(BASH_TOOL) || selectedTools.some(isOctocodeReader) ? "indirect" : undefined;
}

/**
 * Build the ordered, independently replaceable sections of the structured system prompt: collect each default
 * section's content, apply the custom prompt and the producers' sections, and let `composeSystemPromptSections` order
 * and tag them.
 */
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		hiddenTools,
		toolSnippets,
		mcpServers,
		toolGuidelines,
		promptGuidelines,
		appendSystemPrompt,
		sections: customSections,
		baseSections,
		cwd,
		environment,
		contextFiles,
		skills,
	} = options;

	for (const name of [...Object.keys(customSections), ...Object.keys(baseSections)])
		assertSystemPromptSectionName(name);

	const declaredTools = selectedTools.filter((name) => !hiddenTools.includes(name));
	const contents: Record<string, string> = { preamble: customPrompt || renderInstruction("system/preamble.md") };
	// One line per declared tool that has a snippet, in the order requests declare them (a tool hidden from requests is
	// left out). A snippet is a fact about the tool, like its declaration, so the list follows the tool set under a
	// custom prompt too. MCP tools are described in `mcps`, so a snippet on one is ignored; each server in `mcpServers`
	// instead gets one `mcp__<server>__*` line after them. A tool without a snippet is not listed and the section is
	// absent when none has one: SDK sessions and extension tools set it optionally, while a test requires it of every
	// native tool.
	const listedTools = declaredTools.filter((name) => !isMcpToolName(name) && !!toolSnippets[name]);
	contents.tools = [
		...listedTools.map((name) => `- ${name}: ${toolSnippets[name]}`),
		...Object.entries(mcpServers)
			.filter(([, purpose]) => purpose)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([namespace, purpose]) => `- ${namespace}__*: ${purpose}`),
	].join("\n");
	// One predicate decides who owns code search: Octocode, when one of its search tools is declared or the policy's
	// research section already routes search to it (a server still connecting); otherwise bash, when it is declared.
	const octocodeSearch = declaredTools.some(isOctocodeSearch) || routesSearchToOctocode(customSections);
	contents.rules = buildRules(
		declaredTools,
		toolGuidelines,
		promptGuidelines,
		!customPrompt && !customSections.communication,
		!customPrompt && declaredTools.includes(BASH_TOOL) && !octocodeSearch,
	);
	contents.docs = renderInstruction("system/docs.md", { root: dirname(getReadmePath()) });
	// A custom prompt stands in for the default docs (and the default rule lines above); every other section stays.
	if (customPrompt)
		for (const name of Object.keys(contents))
			if (systemPromptSectionSpec(name)?.underCustomPrompt === "drop") delete contents[name];

	Object.assign(contents, baseSections);
	contents.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) contents.project_context = renderProjectContext(contextFiles);
	// A hidden reader is still reachable through another tool, so skills stay but the hint names no tool.
	const reader = skillReader(selectedTools, declaredTools);
	if (reader && skills.length > 0) contents.skills = formatSkillsForPrompt(skills, reader).trim();
	contents.cwd = cwd.replace(/\\/g, "/");
	if (environment) contents.environment = environment;
	// A producer's section replaces the default of that name; an empty one removes it.
	for (const [name, content] of Object.entries(customSections)) {
		if (content) contents[name] = content;
		else if (content === "") delete contents[name];
	}
	return composeSystemPromptSections(contents, new Set(Object.keys(baseSections)));
}

/**
 * The complete prompt state for `input`. A forced prompt is opaque and lives in `content`
 * with no sections; otherwise `content` is empty and the structured sections carry the prompt.
 */
export function buildSystemPromptState(input: BuildSystemPromptOptions): {
	content: string;
	sections?: SystemPromptSections;
} {
	if (input.forceSystemPrompt !== undefined) return { content: input.forceSystemPrompt };
	return { content: "", sections: buildSystemPromptSections(input) };
}

/** Build the system prompt text, rendered exactly as the transcript's system message replays it. */
export function buildSystemPrompt(input: BuildSystemPromptOptions): string {
	return getSystemMessageText({ role: "system", ...buildSystemPromptState(input), timestamp: 0 });
}

/**
 * Diff the sections the model currently has (replayed from the transcript, so never null)
 * against the desired ones. Returns a `SystemMessage.sections` patch, or undefined when
 * nothing changed.
 */
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}
