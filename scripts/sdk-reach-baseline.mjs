/**
 * Interactive layers the headless session factory (`core/agent-session/create-session.ts` and `core/agent-session-services.ts`) still reaches through static value imports, as
 * `importer -> tui | webview | file under modes/` with importers relative to `packages/`. `check:boundaries` fails on a
 * new edge and on a listed edge that is gone. Shrink it by moving theme, keybinding and render helpers out of the
 * terminal layers; the HTML exporter (`core/export-html`) loads lazily and `@octocodeai/octocode-tui/multiplexer` is
 * headless, so neither is an edge. Never add to it.
 */
export const SDK_REACH_BASELINE = [
	"coding-agent/src/core/resource-loader/collections.ts -> tui",
	"coding-agent/src/theme/system-theme.ts -> tui",
	"coding-agent/src/theme/theme-class.ts -> tui",
	"coding-agent/src/theme/theme-loader.ts -> tui",
	"coding-agent/src/utils/image-convert.ts -> tui",
	"mcp/src/presentation/result-row.ts -> tui",
	"mcp/src/ui.ts -> tui",
];
