import { MCP_STATUS_SECTION, MCPS_SECTION } from "../../../common/src/mcp-names.ts";

/**
 * The one declaration of every known system prompt section: its order, cache tier, owner and what a custom prompt
 * (`SYSTEM.md`, SDK `customPrompt`) does to it. Producers fill section contents through `BuildSystemPromptOptions`
 * (their defaults) or `before_agent_start` `sections`/`baseSections`; only `composeSystemPromptSections` orders them.
 */

export interface SystemPromptSectionSpec {
	name: string;
	/**
	 * `base`: depends only on the tools and the install, so sessions in other projects or on other days share it (the
	 * first instruction cache block). `session`: stable for a session but project- or role-specific. `volatile`: changes
	 * during a session (the date, plan mode, MCP connection state), so it comes last and its patches stay small.
	 */
	tier: "base" | "session" | "volatile";
	/** The module that writes the content. */
	owner: string;
	/** Under a custom prompt: `replace` takes the custom text, `drop` leaves the default out, `keep` is unchanged. */
	underCustomPrompt: "replace" | "drop" | "keep";
}

type SystemPromptSectionTier = SystemPromptSectionSpec["tier"];

const section = (
	name: string,
	tier: SystemPromptSectionTier,
	owner: string,
	underCustomPrompt: SystemPromptSectionSpec["underCustomPrompt"] = "keep",
): SystemPromptSectionSpec => ({ name, tier, owner, underCustomPrompt });

/** Every known section in prompt order. Unknown extension sections take the two slots named in `composeSystemPromptSections`. */
export const SYSTEM_PROMPT_SECTIONS: readonly SystemPromptSectionSpec[] = [
	section("preamble", "base", "core/system-prompt", "replace"),
	section("tools", "base", "core/system-prompt (tool promptSnippet)"),
	// A custom prompt keeps the tools' guidelines; only the default floor and bash-search lines give way to it.
	section("rules", "base", "core/system-prompt (tool promptGuidelines)"),
	section("docs", "base", "core/system-prompt", "drop"),
	section(MCPS_SECTION, "base", "mcp/section"),
	section("addendum", "session", "core/system-prompt (APPEND_SYSTEM.md)"),
	section("project_context", "session", "core/system-prompt (AGENTS.md)"),
	section("skills", "session", "core/skills"),
	section("cwd", "session", "core/system-prompt"),
	section("octocode_work", "session", "octocode/instructions/policy"),
	section("octocode_research", "session", "octocode/instructions/policy"),
	section("octocode_delegation", "session", "octocode/instructions/policy"),
	section("octocode_safety", "session", "octocode/instructions/policy"),
	section("octocode_communication", "session", "octocode/instructions/policy"),
	section("octocode_lean", "session", "octocode/instructions/lean"),
	section("role", "session", "octocode/turn (subagent role)"),
	section("environment", "volatile", "core/system-prompt (currentEnvironment)"),
	section("planning", "volatile", "octocode/plan"),
	section(MCP_STATUS_SECTION, "volatile", "mcp/section"),
];

const SPECS = new Map(SYSTEM_PROMPT_SECTIONS.map((spec) => [spec.name, spec]));

/** The section's spec, or undefined for a name only an extension writes. */
export function systemPromptSectionSpec(name: string): SystemPromptSectionSpec | undefined {
	return SPECS.get(name);
}

/** Known sections outside the base tier: the first one present starts the second instruction cache block. */
export const NON_BASE_SECTIONS: ReadonlySet<string> = new Set(
	SYSTEM_PROMPT_SECTIONS.filter((spec) => spec.tier !== "base").map((spec) => spec.name),
);

const SECTION_NAME = /^[a-z][a-z0-9_-]*$/;

/** Throw for a name that cannot be a tag, or for `preamble`, which only the prompt itself sets. */
export function assertSystemPromptSectionName(name: string): void {
	if (!SECTION_NAME.test(name) || name === "preamble") throw new Error(`Invalid system prompt section name: ${name}`);
}

/**
 * Order raw section contents by the spec and wrap every section but `preamble` in a tag of its name, so the model can
 * match later updates to it. Unknown names in `extensionBase` follow the known base sections, in their given order;
 * other unknown names end the session tier, before the volatile one. Empty contents are left out.
 */
export function composeSystemPromptSections(
	contents: Readonly<Record<string, string>>,
	extensionBase: ReadonlySet<string> = new Set(),
): Record<string, string> {
	const present = Object.entries(contents).filter(([, text]) => text.length > 0);
	const unknown = present.filter(([name]) => !SPECS.has(name));
	const slots: Record<SystemPromptSectionTier, Array<[string, string]>> = { base: [], session: [], volatile: [] };
	for (const spec of SYSTEM_PROMPT_SECTIONS) {
		const text = contents[spec.name];
		if (text) slots[spec.tier].push([spec.name, text]);
	}
	slots.base.push(...unknown.filter(([name]) => extensionBase.has(name)));
	slots.session.push(...unknown.filter(([name]) => !extensionBase.has(name)));
	const sections: Record<string, string> = {};
	for (const [name, text] of [...slots.base, ...slots.session, ...slots.volatile])
		sections[name] = name === "preamble" ? text : `<${name}>\n${text}\n</${name}>`;
	return sections;
}
