import { BASH_TOOL, SKILL_TOOL } from "./tools/tool-names.ts";
import { currentToolRoles } from "../../../mcp/src/api.ts";
import { isMcpToolName } from "@octocodeai/octocode-common/mcp-names";
/**
 * System prompt construction and project context loading
 */

import { getSystemMessageText } from "@octocodeai/octocode-ai";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getReadmePath } from "../config.ts";
import { renderInstruction } from "./prompt-template.ts";
import { checkoutLabel, octocodeWorktreeAt } from "./worktree-path.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";
import { formatHarnessesForPrompt } from "./discovery/vendors/prompt.ts";
import type { HarnessStatus } from "./discovery/vendors/types.ts";
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
	 * Registered tools left undeclared until first use (`ToolDefinition.onDemand`), loaded or not. Each is listed in the
	 * `tools` section after the other tools, in this order, so loading one never moves a line.
	 */
	onDemandTools?: string[];
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
	/** Every harness Octocode reads, on or off: one `harnesses` line, so the agent knows what exists and who switches it. */
	harnesses?: readonly HarnessStatus[];
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

/** Where the session's replies go: a run mode, or a subagent whose parent reads them. */
export type SessionSurface = "tui" | "print" | "json" | "rpc" | "subagent";

/** The surface facts of the `environment` section; all optional, so a caller without them keeps the short form. */
export interface EnvironmentSurface {
	surface?: SessionSurface;
	/** What hosts the terminal (`terminalHostFacts`), joined for the prompt. */
	host?: string;
	/** Whether replies draw `mermaid` blocks as diagrams. */
	mermaid?: boolean;
}

/**
 * The `environment` section (`octocode/instructions/system/environment.md`): platform and shell, today's local date,
 * a linked worktree, and where the session runs (surface, terminal host, whether replies draw Mermaid). It sits in
 * the volatile tier after the cache breakpoints, so a new day or a changed surface changes only this section. No
 * process name or pid: sessions of one configuration in different processes keep the same prefix.
 */
export function currentEnvironment(
	now = new Date(),
	env: NodeJS.ProcessEnv = process.env,
	worktree?: string,
	surface: EnvironmentSurface = {},
): string {
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const shell = env.SHELL?.split(/[\\/]/).pop() || (process.platform === "win32" ? "cmd" : "sh");
	const kind = surface.surface;
	return renderInstruction("system/environment.md", {
		platform: process.platform,
		arch: process.arch,
		shell,
		date,
		worktree,
		subagent: kind === "subagent",
		tui: kind === "tui",
		print: kind === "print",
		json: kind === "json",
		rpc: kind === "rpc",
		host: surface.host,
		mermaid: surface.mermaid === true,
	}).trimEnd();
}

/**
 * The `Checkout:` fact for a session that runs in a linked git worktree (`worktree <name>`, with the main checkout and
 * branch when they are cheap to read); undefined in a main checkout or a plain folder. Two small file reads, no git process.
 */
export function linkedWorktreeFact(folder: string): string | undefined {
	if (!checkoutLabel(folder)?.startsWith("worktree ")) return undefined;
	const main = octocodeWorktreeAt(folder)?.main;
	let branch: string | undefined;
	try {
		const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(join(folder, ".git"), "utf8"))?.[1];
		const head = pointer ? readFileSync(join(resolve(folder, pointer), "HEAD"), "utf8") : "";
		branch = /^ref: refs\/heads\/(.+)$/mu.exec(head)?.[1]?.trim();
	} catch {
		// Branch is optional: a detached or unreadable HEAD leaves it out.
	}
	return `linked worktree${main ? ` of ${main}` : ""}${branch ? `, branch ${branch}` : ""}`;
}
/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? [BASH_TOOL])],
		hiddenTools: [...(input.hiddenTools ?? [])],
		toolSnippets: { ...input.toolSnippets },
		...(input.onDemandTools ? { onDemandTools: [...input.onDemandTools] } : {}),
		mcpServers: { ...input.mcpServers },
		toolGuidelines: Object.fromEntries(
			Object.entries(input.toolGuidelines ?? {}).map(([name, guidelines]) => [name, [...guidelines]]),
		),
		promptGuidelines: [...(input.promptGuidelines ?? [])],
		appendSystemPrompt: input.appendSystemPrompt ?? "",
		sections: { ...input.sections },
		baseSections: { ...input.baseSections },
		cwd: input.cwd,
		...(input.harnesses ? { harnesses: input.harnesses.map((status) => ({ ...status })) } : {}),
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
	// The floor for sessions without Octocode's Communication policy or a lean child's section, which say the same with more detail.
	if (includeFloor) {
		for (const rule of renderInstruction("system/rules-floor.md").split("\n")) addRule(rule);
	}
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/**
 * Whether the policy's `research` section routes code search to the research MCP server (the first server whose entry
 * gives tools a reader and a search role): it names that server's tools by their namespace. The base prompt leaves its
 * own bash search rule out while it does, so only one of the two shows, whether or not the server's tools are declared yet.
 */
function routesSearchToResearch(sections: Record<string, string | undefined>): boolean {
	const research = currentToolRoles().research;
	return research !== undefined && sections.research?.includes(`\`${research.prefix}*\``) === true;
}

/** The skill hint's file reader: the skill tool, then bash; `indirect` when only an MCP reader or another tool reaches files. */
function skillReader(selectedTools: string[], declaredTools: string[]): Parameters<typeof formatSkillsForPrompt>[1] {
	// The skill tool loads a skill by name and needs no file reader, so it comes first. A reader role's tool takes the
	// server's own arguments, so the hint names no tool for it.
	const { readers } = currentToolRoles();
	if (declaredTools.includes(SKILL_TOOL)) return SKILL_TOOL;
	if (declaredTools.some((name) => readers.has(name))) return "indirect";
	if (declaredTools.includes(BASH_TOOL)) return "bash";
	return selectedTools.includes(BASH_TOOL) || selectedTools.some((name) => readers.has(name)) ? "indirect" : undefined;
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
		onDemandTools = [],
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
	// On-demand tools follow the rest whether loaded or not, so a load leaves the section as it was.
	const onDemand = new Set(onDemandTools);
	const listedTools = [...declaredTools.filter((name) => !onDemand.has(name)), ...onDemandTools].filter(
		(name) => !isMcpToolName(name) && !!toolSnippets[name],
	);
	contents.tools = [
		...listedTools.map((name) => `- ${name}: ${toolSnippets[name]}`),
		...Object.entries(mcpServers)
			.filter(([, purpose]) => purpose)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([namespace, purpose]) => `- ${namespace}__*: ${purpose}`),
	].join("\n");
	// One predicate decides who owns code search: an MCP server, when a tool with a search role is declared or the
	// policy's research section already routes search to it (a server still connecting); otherwise bash, when declared.
	const { searches } = currentToolRoles();
	const researchSearch = declaredTools.some((name) => searches.has(name)) || routesSearchToResearch(customSections);
	contents.rules = buildRules(
		declaredTools,
		toolGuidelines,
		promptGuidelines,
		!customPrompt && !customSections.communication && !customSections.lean,
		!customPrompt && declaredTools.includes(BASH_TOOL) && !researchSearch,
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
	const harnesses = formatHarnessesForPrompt(input.harnesses ?? []);
	if (harnesses) contents.harnesses = harnesses;
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
