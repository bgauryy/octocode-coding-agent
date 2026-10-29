import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/index.ts";
import { openFile } from "../shared/open.ts";
import type { SessionAttach } from "./attach-register.ts";
import type { WorkspaceRuntime } from "../workspace/runtime.ts";
import { registerSessionAttach } from "./attach-register.ts";
import { ensureWebDaemon, waitForSession, type LaunchOptions } from "./launcher.ts";
import { webDaemonEnabled } from "./paths.ts";

/**
 * `/octocode` with `OCTOCODE_WEB_DAEMON=1`: makes sure this session accepts the daemon, starts or reuses the daemon,
 * and opens the page on this session. The URL fragment carries the launch token and the requested view. Returns false when the flag is off. Throws when
 * the daemon cannot be reached or this session cannot attach, so the caller falls back to the per-session server.
 */
export function daemonOpener(
	attach: SessionAttach,
	options: LaunchOptions & { open?: (url: string) => Promise<void>; sessionWaitMs?: number } = {},
): (ctx: ExtensionCommandContext, view: "board" | "activity") => Promise<boolean> {
	return async (ctx, view) => {
		if (!webDaemonEnabled(options.env)) return false;
		const endpoint = await attach.ensure(ctx);
		if (!endpoint) throw new Error("This session cannot accept the web daemon.");
		const daemon = await ensureWebDaemon(options);
		// A page opened before the daemon can reach this session would show an error: use the per-session server instead.
		if (!(await waitForSession(daemon, endpoint.sessionId, options.sessionWaitMs)))
			throw new Error("This session did not attach to the web daemon in time.");
		const url = new URL(daemon.origin + "/");
		url.searchParams.set("s", endpoint.sessionId);
		url.hash = new URLSearchParams({ access: daemon.token, view }).toString();
		await (options.open ?? openFile)(url.href);
		return true;
	};
}

/**
 * Registers the session's attach endpoint (a subagent, which has no `workspace`, gets none) and returns the opener for
 * `/octocode`: with `OCTOCODE_WEB_DAEMON` off it returns false and the per-session server opens as before.
 */
export function registerWebDaemon(api: ExtensionAPI, workspace: WorkspaceRuntime | undefined) {
	return daemonOpener(registerSessionAttach(api, { isSubagent: workspace === undefined, workspace }));
}
