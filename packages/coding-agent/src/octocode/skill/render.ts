import type { Component } from "@octocodeai/octocode-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
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
