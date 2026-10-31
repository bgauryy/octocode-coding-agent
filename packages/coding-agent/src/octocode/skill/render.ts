import type { Component } from "@octocodeai/octocode-tui";
import type { Skill } from "../../core/skills.ts";
import type { Theme } from "../../theme/theme.ts";
import { toolHeader } from "../shared/render.ts";
import type { RenderContext } from "../shared/render/types.ts";

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
