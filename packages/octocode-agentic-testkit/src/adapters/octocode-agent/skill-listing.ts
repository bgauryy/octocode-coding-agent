import type { Skill } from "../../agents/inproc.ts";

/** One catalog line of the `skill` tool's description: `<path>/<name>/SKILL.md: <description>`. */
const CATALOG_LINE = /^\S*?([^/\s]+)\/SKILL\.md: (.+)$/gm;

type ToolDef = { name?: string; description?: string };

/** The `skill` tool's description in a captured request's raw `tools` (OpenAI or Anthropic shape); empty when absent. */
export function skillToolDescription(raw: unknown): string {
	const tools = (raw as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) return "";
	for (const tool of tools as (ToolDef & { function?: ToolDef })[]) {
		const def = tool.function ?? tool;
		if (def.name === "skill") return def.description ?? "";
	}
	return "";
}

/** The skills the `skill` tool's description catalogs (`path: description` lines); the name is the skill's folder. */
export function parseSkillListing(skillToolText: string): Pick<Skill, "name" | "description">[] {
	return [...skillToolText.matchAll(CATALOG_LINE)].map((m) => ({ name: m[1], description: m[2] }));
}
