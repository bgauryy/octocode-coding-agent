import type { EditorTheme } from "@octocodeai/octocode-tui";
import type { FeatureContext } from "../../../core/features/index.ts";

export type DialogTheme = Parameters<Parameters<FeatureContext["ui"]["custom"]>[0]>[1];

export function editorTheme(theme: DialogTheme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}
