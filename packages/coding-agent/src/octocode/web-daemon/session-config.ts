import { randomBytes } from "node:crypto";
import type { SessionConfig } from "../workspace/server.ts";
import { createConfigRoutes } from "./config-factory.ts";
import { handleConfigRequest } from "./config-routes.ts";

/** The one repository id the per-session page offers; the webview sends it back as `repoId`. */
const SESSION_REPO_ID = "session";

/**
 * Settings routes for the per-session `/web` page. The page's single token is the launch capability, so the server
 * calls `handle` only after its token check. Only this session's repository resolves; any other id answers 404.
 */
export function createSessionConfig(
	repo: { name: string; root: string },
	env: NodeJS.ProcessEnv = process.env,
): SessionConfig {
	const nonce = randomBytes(4).toString("hex");
	const { routes, signIns } = createConfigRoutes({ env, actor: () => `web:${nonce}` });
	const catalog = {
		resolve: (id: string) =>
			id === SESSION_REPO_ID ? { id, name: repo.name, root: repo.root, sessions: 1 } : undefined,
	};
	return {
		handle: (req, url, reply) => handleConfigRequest(req, url, "launch", { catalog, ...routes }, reply),
		close: () => signIns.closeAll(),
	};
}
