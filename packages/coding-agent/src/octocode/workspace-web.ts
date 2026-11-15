import type { RevisedWorkspace } from "./workspace/revision.ts";
import { startWorkspaceWeb } from "./workspace/server.ts";
import { createSessionConfig } from "./web-daemon/session-config.ts";
import type { NativeToolsLive } from "./web-daemon/tool-exposure.ts";
import { isFolderTrusted } from "./trust/port.ts";
import { MCP_MANAGE_TOOL_NAME } from "../../../common/src/mcp-names.ts";
import { nativeToolsDeclared, nativeToolsSaved } from "./permission/native-deferral.ts";
import { getNativeToolNames } from "./permission/native-tools.ts";

/**
 * This session's native tools (`permission` owns them) for the Settings → Tools panel: every registered name and how
 * each deferrable one was declared. The web daemon's page asks the session for it over the attach endpoint; this
 * session's own server reads it in process.
 */
export const sessionNativeTools = (): NativeToolsLive => ({
	names: [...getNativeToolNames(), MCP_MANAGE_TOOL_NAME],
	declared: nativeToolsDeclared(),
	saved: nativeToolsSaved(),
});

/**
 * Starts a session's own workspace page, the fallback when the web daemon cannot start, with the folder-trust check
 * injected: the workspace domain cannot import trust, so this root module, which may use both, decides which projects
 * show their repository documents. It also supplies the Settings routes, which `web-daemon` owns, with this session's
 * native tools for the Tools panel.
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
		createSessionConfig({ name: backlog.repoName, root: backlog.repoRoot }, process.env, sessionNativeTools),
	);
