/** Type-only vocabulary of the theme modules. A leaf: it imports nothing that renders or loads a theme. */
export type { ThemeBg, ThemeColor, ThemeToken } from "./theme-tokens.ts";

/** Whether a terminal, or the background a theme is designed for, is dark or light. */
export type ThemeAppearance = "dark" | "light";
