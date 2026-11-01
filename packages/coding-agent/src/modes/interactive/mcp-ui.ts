/**
 * The MCP workspace's terminal view port: the `/mcp` manager's frame, key hints, sign-in line and view runner. The
 * interactive mode installs it (`mcp-ui-install.ts`); other modes never draw these views.
 */

import { installMcpHost, type McpHostPorts } from "../../../../mcp/src/host.ts";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { getSelectListTheme, type Theme } from "../../theme/theme.ts";
import { AuthUrlComponent } from "./components/auth-url.ts";
import { frame, renderClipped, runInView } from "./components/framed-view.ts";
import { keyHint } from "./components/keybinding-hints.ts";

type Keybinding = Parameters<typeof keyHint>[0];

const ui: McpHostPorts["ui"] = {
	keyHint: (keybinding, description) => keyHint(keybinding as Keybinding, description),
	frame: (theme, title, body, footer) => frame(theme as Theme, title, body, footer),
	renderClipped,
	selectListTheme: getSelectListTheme,
	authUrl: (tui, url) => new AuthUrlComponent(tui, url),
	runInView: (ctx, create, run) =>
		runInView(
			ctx as unknown as ExtensionCommandContext,
			(tui, theme, keybindings) => create(tui, theme, keybindings),
			run,
		),
};

export function installMcpUiPort(): void {
	installMcpHost({ ui });
}
