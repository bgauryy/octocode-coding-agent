import type { ExtensionUIContext } from "../../core/features/index.ts";
import { SearchableSelectorComponent } from "./components/searchable-selector.ts";
import { sanitizeTerminalText } from "@octocodeai/octocode-common/sanitize";

export interface ReferencePickerHost {
	showExtensionCustom: ExtensionUIContext["custom"];
}

export function chooseReference(
	host: ReferencePickerHost,
	title: string,
	labels: string[],
): Promise<string | undefined> {
	return host.showExtensionCustom<string | undefined>(
		(_ui, _theme, _keys, done) =>
			new SearchableSelectorComponent(
				sanitizeTerminalText(title),
				labels.map((label) => ({ value: label, label: sanitizeTerminalText(label) })),
				done,
				() => done(undefined),
			),
	);
}
