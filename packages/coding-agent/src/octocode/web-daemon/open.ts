import type { ExtensionCommandContext, ExtensionContext } from "../../core/extensions/index.ts";
import { openFile } from "../shared/open.ts";
import type { SessionAttach } from "./attach-register.ts";
import { ensureWebDaemon, waitForSession, type LaunchedDaemon, type LaunchOptions } from "./launcher.ts";
import { webDaemonEnabled } from "./paths.ts";

/**
 * The running daemon with this session attached to it, for a command that needs both (`/octocode`, `/remote`): starts
 * or reuses the daemon and waits until it lists this session. Undefined with `OCTOCODE_WEB_DAEMON` off; throws when
 * the daemon cannot be reached or this session cannot attach.
 */
export async function attachedDaemon(
	attach: SessionAttach,
	ctx: ExtensionContext,
	options: LaunchOptions & { sessionWaitMs?: number } = {},
): Promise<(LaunchedDaemon & { sessionId: string }) | undefined> {
	if (!webDaemonEnabled(options.env)) return undefined;
	const endpoint = await attach.ensure(ctx);
	if (!endpoint) throw new Error("This session cannot accept the web daemon.");
	const daemon = await ensureWebDaemon(options);
	if (!(await waitForSession(daemon, endpoint.sessionId, options.sessionWaitMs)))
		throw new Error("This session did not attach to the web daemon in time.");
	return { ...daemon, sessionId: endpoint.sessionId };
}

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
		// A page opened before the daemon can reach this session would show an error: use the per-session server instead.
		const daemon = await attachedDaemon(attach, ctx, options);
		if (!daemon) return false;
		const url = new URL(daemon.origin + "/");
		url.searchParams.set("s", daemon.sessionId);
		url.hash = new URLSearchParams({ access: daemon.token, view }).toString();
		await (options.open ?? openFile)(url.href);
		return true;
	};
}
