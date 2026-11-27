import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { serialQueue } from "@octocodeai/octocode-common/serial-queue";
import { openBacklog } from "../backlog/context.ts";
import type { WorkspaceRuntime } from "../workspace/runtime.ts";
import { startAttachServer, type AttachEndpoint } from "./attach-server.ts";
import { sessionToolStates } from "./session-tools.ts";
import type { NativeToolsLive } from "./tool-exposure.ts";

export interface SessionAttach {
	/** Starts this session's attach endpoint when it is not running; undefined for a subagent or a host without a workspace. */
	ensure(ctx: FeatureContext): Promise<AttachEndpoint | undefined>;
}

/**
 * Every non-subagent session starts an owner-only attach endpoint at `session_start`, so the user-level web daemon can
 * list and reach it, and stops it (removing its record) at `session_shutdown`. `nativeTools` lets the session's page
 * show what the session declares of each tool; `boardChanged` repaints the session's board counts after the daemon
 * changed the board.
 */
export function registerSessionAttach(
	api: FeatureSetup,
	options: {
		isSubagent: boolean;
		workspace?: WorkspaceRuntime;
		env?: NodeJS.ProcessEnv;
		nativeTools?: () => NativeToolsLive;
		boardChanged?: (ctx: FeatureContext) => void;
	},
): SessionAttach {
	const env = options.env ?? process.env;
	let endpoint: AttachEndpoint | undefined;
	const enqueue = serialQueue();
	const stop = () =>
		enqueue(async () => {
			const previous = endpoint;
			endpoint = undefined;
			await previous?.close();
		});
	const start = (ctx: FeatureContext) =>
		enqueue(async () => {
			const { workspace, nativeTools, boardChanged } = options;
			if (options.isSubagent || !workspace) return undefined;
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
					...(nativeTools ? { tools: () => sessionToolStates(nativeTools()) } : {}),
					...(boardChanged ? { boardChanged: () => boardChanged(ctx) } : {}),
				},
				env,
			);
			return endpoint;
		});
	if (!options.isSubagent && options.workspace) {
		// A session that cannot attach (an unreadable database, no free port) still works; `/web` tries again and says why.
		api.bus.on("session_start", (_event, ctx) => void start(ctx).catch(() => undefined));
		api.bus.on("session_shutdown", () => stop());
	}
	return { ensure: start };
}
