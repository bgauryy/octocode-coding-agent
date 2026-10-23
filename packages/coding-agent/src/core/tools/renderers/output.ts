/** Rendering pieces shared by the built-in tool renderers. */

import { Text } from "@octocodeai/octocode-tui";

/** The previous render's `Text` component (or a new one) holding `value`. */
export function reuseText(context: { lastComponent: unknown }, value: string): Text {
	const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(value);
	return text;
}
