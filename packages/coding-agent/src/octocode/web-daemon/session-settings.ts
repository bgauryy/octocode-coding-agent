import type http from "node:http";
import type { AttachClient } from "./attach-client.ts";
import { handleConfigRequest, type ConfigRoutes } from "./config-routes.ts";
import type { Reply, TokenAccess } from "./http-util.ts";
import type { RepoInfo } from "./repos.ts";
import { SESSION_REPO_ID } from "./session-config.ts";
import { liveTools, type LiveTools } from "./session-tools.ts";

const ADMIN_PREFIX = "/api/admin/";

/**
 * The Settings view of an attached session's page (`/s/<id>/api/config` and `/s/<id>/api/admin/config/*`): the
 * daemon's settings routes with that session's repository as the one workspace (`repoId=session`, as on the session's
 * own server), and a Tools panel that shows what the running session declares, which the session answers itself
 * (`session.tools`). Tools display can fall back for an older session; Add MCP refuses without complete registry names.
 * Admin routes belong to the launch token here as at the top level. Returns false for any other route.
 */
export async function handleSessionSettings(
	req: http.IncomingMessage,
	url: URL,
	access: TokenAccess,
	routes: Omit<ConfigRoutes, "catalog">,
	session: { client: Pick<AttachClient, "tools"> },
	repo: RepoInfo,
	reply: Reply,
): Promise<boolean> {
	if (access !== "launch" && url.pathname.startsWith(ADMIN_PREFIX)) {
		reply(403, { error: "This link cannot use admin routes. Run the command in the Octocode terminal." });
		return true;
	}
	const live = (): Promise<LiveTools | undefined> => session.client.tools().then(liveTools, () => undefined);
	const { tools, writeTools, addMcp, mcpAddStatus } = routes;
	const addLive = async (): Promise<LiveTools> => (await live()) ?? { mcpServerNames: () => undefined };
	return handleConfigRequest(
		req,
		url,
		access,
		{
			...routes,
			catalog: { resolve: (id) => (id === SESSION_REPO_ID ? repo : undefined) },
			...(tools ? { tools: async (target) => tools(target, await live()) } : {}),
			...(mcpAddStatus ? { mcpAddStatus: async (target) => mcpAddStatus(target, await addLive()) } : {}),
			...(addMcp ? { addMcp: async (command, target) => addMcp(command, target, await addLive()) } : {}),
			...(writeTools ? { writeTools: async (command, target) => writeTools(command, target, await live()) } : {}),
		},
		reply,
	);
}
