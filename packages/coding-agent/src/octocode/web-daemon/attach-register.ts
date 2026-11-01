import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { openBacklog } from "../backlog/context.ts";
import type { WorkspaceRuntime } from "../workspace/runtime.ts";
import { startAttachServer, type AttachEndpoint } from "./attach-server.ts";
import { webDaemonEnabled } from "./paths.ts";

export interface SessionAttach {
	/** Starts this session's attach endpoint when `OCTOCODE_WEB_DAEMON=1` and it is not running; undefined when off. */
	ensure(ctx: ExtensionContext): Promise<AttachEndpoint | undefined>;
}

/**
 * Every non-subagent session starts an owner-only attach endpoint at `session_start` while `OCTOCODE_WEB_DAEMON=1`,
 * and stops it (removing its record) at `session_shutdown`. With the flag off nothing listens and nothing is written.
 */
export function registerSessionAttach(
	api: ExtensionAPI,
	options: { isSubagent: boolean; workspace?: WorkspaceRuntime; env?: NodeJS.ProcessEnv },
): SessionAttach {
	const env = options.env ?? process.env;
	let endpoint: AttachEndpoint | undefined;
	let pending: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
		const next = pending.then(action);
		pending = next.catch(() => undefined);
		return next;
	};
	const stop = () =>
		enqueue(async () => {
			const previous = endpoint;
			endpoint = undefined;
			await previous?.close();
		});
	const start = (ctx: ExtensionContext) =>
		enqueue(async () => {
			const { workspace } = options;
			if (options.isSubagent || !workspace || !webDaemonEnabled(env)) return undefined;
			const sessionId = ctx.sessionManager.getSessionId();
			if (endpoint?.sessionId === sessionId) return endpoint;
			const previous = endpoint;
			endpoint = undefined;
			await previous?.close();
			const backlog = openBacklog(ctx, { isSubagent: false, env });
			endpoint = await startAttachServer(
				{
					sessionId,
					cwd: ctx.cwd,
					repo: { key: backlog.store.repo, name: backlog.repoName, root: backlog.repoRoot },
					workspace: workspace.bind(ctx, backlog),
				},
				env,
			);
			return endpoint;
		});
	if (!options.isSubagent && options.workspace) {
		// A session that cannot attach (an unreadable database, no free port) still works; /web falls back.
		api.on("session_start", (_event, ctx) => void start(ctx).catch(() => undefined));
		api.on("session_shutdown", () => stop());
	}
	return { ensure: start };
}
