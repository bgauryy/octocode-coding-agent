import { BASH_TOOL, READ_TOOL, SKILL_TOOL } from "./tools/tool-names.ts";
import { isOctocodeReader, isOctocodeSearch } from "../../../mcp/src/presets/octocode/names.ts";
/**
 * System prompt construction and project context loading
 */

import { getSystemMessageText } from "@octocodeai/octocode-ai";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { policyRoutesSearchToOctocode } from "../octocode/instructions/policy.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces the default prefix). */
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
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
	/** Additional guideline bullets appended to the default system prompt rules. */
	promptGuidelines?: string[];
	/** Text appended from user configuration before project context, skills, and cwd. */
	appendSystemPrompt?: string;
	/** Additional XML-wrapped prompt sections keyed by tag name, placed after the session's own sections. */
	sections?: Record<string, string>;
	/**
	 * XML-wrapped sections that depend only on the tools and the install, such as each MCP server's generated file,
	 * keyed by tag name. They follow `docs` (the preamble for a custom prompt) in the given order, before project
	 * context, so sessions in other projects or on other days share them in the first instruction cache block.
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

const SYSTEM_PROMPT_SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

/**
 * The `environment` section: platform and shell (command flags differ between them) and today's local date (research
 * on versions, releases and advisories needs it). The last default section (custom sections follow it); a new day
 * changes only this section, which reaches the model as a section update instead of rewriting the prompt the session
 * started with.
 */
export function currentEnvironment(now = new Date(), env: NodeJS.ProcessEnv = process.env): string {
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const shell = env.SHELL?.split(/[\\/]/).pop() || (process.platform === "win32" ? "cmd" : "sh");
	return `Platform: ${process.platform} ${process.arch}\nShell: ${shell}\nDate: ${date}`;
}
/** Normalize prompt input into the mutable, collection-complete shape exposed to extensions. */
export function normalizeBuildSystemPromptOptions(input: BuildSystemPromptOptions): NormalizedBuildSystemPromptOptions {
	return {
		customPrompt: input.customPrompt,
		forceSystemPrompt: input.forceSystemPrompt,
		selectedTools: [...(input.selectedTools ?? [BASH_TOOL])],
		hiddenTools: [...(input.hiddenTools ?? [])],
		toolSnippets: { ...input.toolSnippets },
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
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
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

	if (bashSearch) addRule("Use bash for file operations like ls, rg, find");

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	for (const rule of promptGuidelines) addRule(rule);
	// The floor for sessions without Octocode's Communication policy, which says the same with more detail.
	if (includeFloor) {
		addRule("Be concise in your responses");
		addRule("Refer to files by their paths");
	}
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
export function buildSystemPromptSections(input: BuildSystemPromptOptions): SystemPromptSections {
	const options = normalizeBuildSystemPromptOptions(input);
	const {
		customPrompt,
		selectedTools,
		hiddenTools,
		toolSnippets,
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

	for (const name of [...Object.keys(customSections), ...Object.keys(baseSections)]) {
		if (!SYSTEM_PROMPT_SECTION_NAME.test(name) || name === "preamble") {
			throw new Error(`Invalid system prompt section name: ${name}`);
		}
	}

	const declaredTools = selectedTools.filter((name) => !hiddenTools.includes(name));
	const promptSections: Record<string, string> = {};
	if (customPrompt) {
		promptSections.preamble = customPrompt;
	} else {
		promptSections.preamble =
			"You are a coding assistant operating inside Octocode, a coding agent harness. You help users understand and change code: you research the code and its dependencies, edit files, run commands and checks, and report what you verified.";
		const visibleTools = declaredTools.filter((name) => !!toolSnippets[name]);
		const tools =
			visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
		promptSections.tools = tools;
		// One predicate decides who owns code search: Octocode, when one of its search tools is declared or the policy's
		// research section already routes search to it (a server still connecting); otherwise bash, when it is declared.
		const octocodeSearch = declaredTools.some(isOctocodeSearch) || policyRoutesSearchToOctocode(customSections);
		promptSections.rules = buildRules(
			declaredTools,
			toolGuidelines,
			promptGuidelines,
			!customSections.octocode_communication,
			declaredTools.includes(BASH_TOOL) && !octocodeSearch,
		);
		promptSections.docs = `Octocode documentation (read only when the user asks about Octocode itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}; docs/index.md maps every Octocode topic to its page
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- Resolve docs/... under Additional docs and examples/... under Examples, not the current working directory. Read the docs and examples that define the behavior, follow .md cross-references a task depends on, and read a whole section when its conditions or exceptions matter.`;
	}

	for (const [name, content] of Object.entries(baseSections)) if (content) promptSections[name] = content;
	if (appendSystemPrompt) promptSections.addendum = appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	// A hidden reader is still reachable through another tool, so skills stay but the hint names no tool.
	// The skill tool loads a skill by name and needs no file reader, so it comes first. Octocode ships no `read` tool;
	// an SDK session that declares its own file reader still lists its skills, with a hint that names no tool.
	const skillFileReadTool = declaredTools.includes(SKILL_TOOL)
		? SKILL_TOOL
		: declaredTools.some(isOctocodeReader)
			? "octocode"
			: declaredTools.includes(BASH_TOOL)
				? "bash"
				: declaredTools.includes(READ_TOOL) || selectedTools.includes(BASH_TOOL) || selectedTools.some(isOctocodeReader)
					? "indirect"
					: undefined;
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	promptSections.cwd = cwd.replace(/\\/g, "/");
	if (environment) promptSections.environment = environment;
	// An empty custom section removes the default section of that name.
	for (const [name, content] of Object.entries(customSections)) {
		if (content) promptSections[name] = content;
		else if (content === "") delete promptSections[name];
	}

	const sections: SystemPromptSections = { preamble: promptSections.preamble };
	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
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
