import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/features/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { registerSessionAttach } from "../web-daemon/attach-register.ts";
import { setItemLinkHandler } from "../shared/item-ref.ts";
import { attachedDaemon, daemonOpener } from "../web-daemon/open.ts";
import type { NativeToolsLive } from "../web-daemon/tool-exposure.ts";
import { webCommand } from "../workspace/command.ts";
import type { WorkspaceRuntime } from "../workspace/runtime.ts";
import { registerRemoteAutoStart, remoteCommand, type RemoteHost } from "./command.ts";

/**
 * The commands that reach this session through the user-level web daemon: `/web` opens the daemon's page (this
 * session's own server when the daemon cannot start) and `/remote` publishes the daemon for another device, with
 * `remote.autoStart` at session start. One attach endpoint serves both; it also answers the page's Tools panel with
 * `nativeTools` and repaints the board counts with `boardChanged` after an edit on the page. Never registered for a
 * subagent.
 */
export function registerWebCommands(
	api: ExtensionAPI,
	options: {
		commands: Subcommands;
		workspace: WorkspaceRuntime | undefined;
		openWorkspace: (ctx: ExtensionContext, view: "board" | "activity", item?: string) => Promise<string>;
		nativeTools?: () => NativeToolsLive;
		boardChanged?: (ctx: ExtensionContext) => void;
	},
): void {
	const attach = registerSessionAttach(api, {
		isSubagent: options.workspace === undefined,
		workspace: options.workspace,
		...(options.nativeTools ? { nativeTools: options.nativeTools } : {}),
		...(options.boardChanged ? { boardChanged: options.boardChanged } : {}),
	});
	const web = webCommand(
		options.openWorkspace,
		daemonOpener(attach, { window: () => api.getSettings().web?.window ?? "app" }),
	);
	options.commands.add("web", web);
	// A click on a drawn backlog id in fullscreen mode runs `/web item <id>` on this session.
	let context: ExtensionContext | undefined;
	api.on("session_start", (_event, ctx) => {
		context = ctx;
	});
	setItemLinkHandler((ref) => {
		// A command context adds session controls `/web` never calls.
		if (context) void web.handler(`item ${ref}`, context as ExtensionCommandContext);
	});
	const host: RemoteHost = {
		daemon: (ctx) => attachedDaemon(attach, ctx),
		settings: () => api.getSettings().remote ?? {},
	};
	registerRemoteAutoStart(api, host);
	options.commands.add("remote", remoteCommand(host));
}
