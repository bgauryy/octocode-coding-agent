/**
 * Minimal Mode Example - Demonstrates a "minimal" tool display mode
 *
 * This extension overrides the built-in bash tool to provide custom rendering:
 * - Collapsed mode: Only shows the tool call (the command), no output
 * - Expanded mode: Shows full output like the built-in renderers
 *
 * This demonstrates how a "minimal mode" could work, where ctrl+o cycles through:
 * - Standard: Shows truncated output (current default)
 * - Expanded: Shows full output (current expanded)
 * - Minimal: Shows only tool call, no output (this extension's collapsed mode)
 *
 * Usage:
 *   octocode -e ./minimal-mode.ts
 *
 * Then use ctrl+o to toggle between minimal (collapsed) and full (expanded) views.
 */

import { Text } from "@octocodeai/octocode-tui";
import type { ExtensionAPI } from "@octocodeai/octocodecode";
import { createBashToolDefinition } from "@octocodeai/octocodecode";

export default function (octocode: ExtensionAPI) {
	const bash = createBashToolDefinition(process.cwd());

	// =========================================================================
	// Bash Tool
	// =========================================================================
	octocode.registerTool({
		...bash,

		renderCall(args, theme, _context) {
			const command = args.command || "...";
			const timeout = args.timeout;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

			return new Text(theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			// Minimal mode: show nothing in collapsed state
			if (!expanded) {
				return new Text("", 0, 0);
			}

			// Expanded mode: show full output
			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			const output = textContent.text
				.trim()
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");

			if (!output) {
				return new Text("", 0, 0);
			}

			return new Text(`\n${output}`, 0, 0);
		},
	});
}
