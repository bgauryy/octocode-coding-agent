/**
 * The MCP workspace's terminal view port: the `/mcp` manager's frame, key hints, sign-in line and view runner. The
 * interactive mode installs it (`mcp-ui-install.ts`); other modes never draw these views.
 */

import { installMcpHost, type McpHostPorts } from "../../../../mcp/src/api.ts";
import type { ExtensionCommandContext } from "../../core/features/types.ts";
import { type Theme } from "../../theme/theme.ts";
import { AuthUrlComponent } from "./components/auth-url.ts";
import { frame, renderClipped, runInView } from "../../theme/framed-view.ts";
import type { EnterVerb } from "../../theme/page-kit.ts";
import { keyHint } from "../../theme/theme-tui-helpers.ts";
import { ManagePageComponent } from "../../theme/manage-page.ts";

type Keybinding = Parameters<typeof keyHint>[0];

/** The terminal of the view the `/mcp` command runs in: its pages are sized to its rows. */
let viewTerminal: { rows: number } | undefined;

/** The MCP manager's confirm labels in the page vocabulary; `choose` is a selection, and `select` names the same verb directly. */
const ENTER_VERBS: Readonly<Record<string, EnterVerb>> = {
	open: "open",
	run: "run",
	choose: "select",
	select: "select",
	inspect: "inspect",
	confirm: "confirm",
	edit: "edit",
	close: "close",
};

function enterVerb(label: string): EnterVerb | undefined {
	if (label === "") return undefined;
	const verb = ENTER_VERBS[label];
	if (!verb) throw new Error(`Unknown MCP page confirm label: ${label}`);
	return verb;
}

const rowKeys = (keys: ReadonlyArray<{ key: string; label: string }>): Record<string, string> =>
	Object.fromEntries(keys.map(({ key, label }) => [key, label]));

const ui: McpHostPorts["ui"] = {
	keyHint: (keybinding, description) => keyHint(keybinding as Keybinding, description),
	frame: (theme, title, body, footer) => frame(theme as Theme, title, body, footer),
	renderClipped,
	page: (options) =>
		new ManagePageComponent({
			viewportRows: () => (viewTerminal ? viewTerminal.rows - 1 : (process.stdout.rows ?? 24)),
			title: options.title,
			facts: options.facts,
			alerts: options.alerts,
			notes: options.notes,
			sections: [
				{
					heading: options.heading,
					rows: options.keys?.length
						? options.rows.map((row) => ({ ...row, keys: rowKeys(options.keys ?? []) }))
						: options.rows,
					empty: options.empty,
				},
			],
			initialId: options.initialId,
			onKey: options.onKey,
			nested: options.cancelLabel !== "close",
			enter: enterVerb(options.confirmLabel),
			onSelect: options.onSelect,
			onHighlight: options.onHighlight,
			onCancel: options.onCancel,
		}),
	authUrl: (tui, url) => new AuthUrlComponent(tui, url),
	runInView: (ctx, create, run) =>
		runInView(
			ctx as unknown as ExtensionCommandContext,
			(tui, theme, keybindings) => {
				viewTerminal = tui.terminal;
				return create(tui, theme, keybindings);
			},
			run,
		),
};

export function installMcpUiPort(): void {
	installMcpHost({ ui });
}
