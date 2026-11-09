import type { Component } from "@octocodeai/octocode-tui";
import type { Skill } from "../../core/skills.ts";
import type { SkillCategory } from "../../core/skills/category.ts";
import { plural } from "../shared/text.ts";
import type { Theme } from "../../theme/theme.ts";
import { toolHeader } from "../render/tool.ts";
import type { RenderContext } from "../render/types.ts";

/**
 * The row of a model-initiated skill load, `Skill: <name>`: the `skill` tool and a `localFetch` read of a loaded skill's
 * instruction file draw the same header, in the same tool-row style as every other call (its glyph and title tokens
 * come from the active theme, dark or light).
 */
export function skillHeader(theme: Theme, context: RenderContext, name: string): Component {
	return toolHeader(theme, context, name ? `Skill: ${name}` : "Skill", "");
}

/** The line `<skill>` blocks put before the instructions, which a person reads from the path instead. */
const REFERENCES_LINE = /^References are relative to [^\n]*\.\n\n/;

/** The instructions of a loaded skill block (the tool's result or a `/skill:name` message), without the model-facing preamble. */
export function skillInstructions(blockContent: string): string {
	return blockContent.replace(REFERENCES_LINE, "").trim();
}

/** Sources that only say the skill was found in a skills folder: the scope already tells where. */
const FOLDER_SOURCES = new Set(["local", "auto"]);

/** Where a loaded skill came from: `project`, `user`, or `user \u00b7 npm:package` for one a package brought. */
export function skillOrigin(skill: Pick<Skill, "sourceInfo">): string {
	const { scope, source } = skill.sourceInfo;
	return FOLDER_SOURCES.has(source) || source === scope ? scope : `${scope} \u00b7 ${source}`;
}

const GROUP_LABELS: Readonly<Record<SkillCategory, string>> = {
	core: "Core skill",
	octocode: "Octocode skill",
	workspace: "Workspace skill",
	global: "Global skill",
};

/** What a skill-load row records about the skill, beside its instructions. */
export interface SkillLoadFacts {
	lines: number;
	category?: SkillCategory;
	origin?: string;
}

/**
 * The collapsed line of a loaded skill: `Octocode skill \u00b7 120 lines`, or `Global skill \u00b7 40 lines \u00b7 user \u00b7
 * npm:pkg`. Core and Octocode skills ship with the build, so only the other groups say where they were found.
 */
export function skillLoadSummary(facts: SkillLoadFacts): string {
	const shipped = facts.category === "core" || facts.category === "octocode";
	const lines = plural(facts.lines, "line");
	// A result recorded before rows had a group reads as it did then.
	const head = facts.category ? [GROUP_LABELS[facts.category], lines] : [`Loaded ${lines}`];
	return [...head, shipped ? undefined : facts.origin].filter(Boolean).join(" \u00b7 ");
}
