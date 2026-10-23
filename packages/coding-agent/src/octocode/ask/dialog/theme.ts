import type { EditorTheme } from "@octocodeai/octocode-tui";
import type { ExtensionContext } from "../../../core/extensions/index.ts";

export type DialogTheme = Parameters<Parameters<ExtensionContext["ui"]["custom"]>[0]>[1];

export function editorTheme(theme: DialogTheme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}
