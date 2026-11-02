import type { ExtensionAPI, ExtensionCommandContext } from "../../core/features/index.ts";
import type { Subcommands } from "../shared/commands.ts";
import { registerSessionAttach } from "../web-daemon/attach-register.ts";
import { attachedDaemon, daemonOpener } from "../web-daemon/open.ts";
import { webCommand } from "../workspace/command.ts";
import type { WorkspaceRuntime } from "../workspace/runtime.ts";
import { registerRemoteAutoStart, remoteCommand, type RemoteHost } from "./command.ts";

/**
 * The commands that reach this session through the web daemon: `/web` opens the page (the daemon's with
 * `OCTOCODE_WEB_DAEMON=1`, else the per-session server) and `/remote` publishes the daemon for another device, with
 * `remote.autoStart` at session start. One attach endpoint serves both. Never registered for a subagent.
 */
export function registerWebCommands(
	api: ExtensionAPI,
	options: {
		commands: Subcommands;
		workspace: WorkspaceRuntime | undefined;
		openWorkspace: (ctx: ExtensionCommandContext, view: "board" | "activity") => Promise<string>;
	},
): void {
	const attach = registerSessionAttach(api, {
		isSubagent: options.workspace === undefined,
		workspace: options.workspace,
	});
	options.commands.add("web", webCommand(options.openWorkspace, daemonOpener(attach)));
	const host: RemoteHost = {
		daemon: (ctx) => attachedDaemon(attach, ctx),
		settings: () => api.getSettings().remote ?? {},
	};
	registerRemoteAutoStart(api, host);
	options.commands.add("remote", remoteCommand(host));
}
