import type { RevisedWorkspace } from "./workspace/revision.ts";
import { startWorkspaceWeb } from "./workspace/server.ts";
import { createSessionConfig } from "./web-daemon/session-config.ts";
import { isFolderTrusted } from "./trust/port.ts";

/**
 * Starts a session's workspace page with the folder-trust check injected: the workspace domain cannot import trust, so
 * this root module, which may use both, decides which projects show their repository documents. It also supplies the
 * Settings routes, which `web-daemon` owns.
 */
export const startTrustedWorkspaceWeb = (
	backlog: Parameters<typeof startWorkspaceWeb>[0],
	changed: () => void,
	workspace?: RevisedWorkspace,
) =>
	startWorkspaceWeb(
		backlog,
		changed,
		workspace,
		isFolderTrusted,
		undefined,
		createSessionConfig({ name: backlog.repoName, root: backlog.repoRoot }),
	);
