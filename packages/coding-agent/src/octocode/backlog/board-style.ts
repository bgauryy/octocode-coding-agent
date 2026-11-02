import type { TaskState } from "@octocodeai/octocode-contracts/backlogs";
import type { State } from "@octocodeai/octocode-contracts/snapshot";
import type { ThemeColor } from "../../theme/theme-tokens.ts";
import type { Theme } from "../../theme/theme.ts";

/**
 * How the board looks: one glyph per state and a theme token per state and priority. Colours are theme tokens only (so the
 * dark and light themes both stay legible); every state and priority also has a glyph or its own text, so the board reads
 * without colour.
 */
export const STATE_GLYPH: Record<State, string> = { backlog: "⧗", todo: "☐", ongoing: "▶", done: "✓" };
export const TASK_GLYPH: Record<TaskState, string> = { todo: "☐", ongoing: "▶", done: "✓", dropped: "✗" };
export const EPIC_GLYPH = "◆";
export const BLOCKED_GLYPH = "⊘";
export const STALE_GLYPH = "⚠";
export const CURSOR = "›";

export const STATE_COLOR: Record<State, ThemeColor> = {
	ongoing: "accent",
	todo: "text",
	backlog: "muted",
	done: "success",
};
export const TASK_COLOR: Record<TaskState, ThemeColor> = {
	todo: "text",
	ongoing: "accent",
	done: "success",
	dropped: "dim",
};
/** `p0` is the loud one; `p3` fades. */
export const PRIORITY_COLOR: readonly ThemeColor[] = ["error", "warning", "text", "muted"];

/** What a theme paints with: the foreground and bold the board uses. */
export type BoardTheme = Pick<Theme, "fg" | "bg" | "bold">;
