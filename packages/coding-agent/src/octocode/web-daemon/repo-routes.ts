import type { IncomingMessage } from "node:http";
import { WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { backlogSnapshot } from "../backlog/snapshot.ts";
import { handleDocsRequest } from "../workspace/docs.ts";
import { handleReportsRequest } from "../workspace/reports.ts";
import type { Reply } from "./http-util.ts";
import type { RepoCatalog, RepoInfo } from "./repos.ts";

/**
 * The read-only routes both scopes share: the repository's board, audit and saved reports and documents. `self` is the attached
 * session (its claims show as live). Returns true when the request was answered. A write is refused: the phase-1 board
 * is read-only, and writes keep going through a session's own page.
 */
export async function handleRepoRequest(
	req: IncomingMessage,
	url: URL,
	repo: RepoInfo,
	catalog: RepoCatalog,
	self: string | undefined,
	reply: Reply,
): Promise<boolean> {
	const store = () => catalog.store(repo.key);
	if (url.pathname === WORKSPACE_ROUTES.backlogs) {
		if (req.method !== "GET") {
			reply(405, { error: "The board is read-only in the web daemon; use the session's own board to edit." });
			return true;
		}
		reply(200, backlogSnapshot(store(), repo.name, Date.now(), self));
		return true;
	}
	if (url.pathname === WORKSPACE_ROUTES.audit && req.method === "GET") {
		const before = url.searchParams.get("before");
		if (before !== null && !/^[1-9][0-9]*$/.test(before)) {
			reply(400, { error: "Invalid audit cursor" });
			return true;
		}
		const events = store().audit(
			url.searchParams.get("backlogId") ?? undefined,
			100,
			before ? Number(before) : undefined,
		);
		reply(200, { events, before: events.length === 100 ? events[0].id : undefined });
		return true;
	}
	if (url.pathname === WORKSPACE_ROUTES.reports || url.pathname === `${WORKSPACE_ROUTES.reports}/file`) {
		if (!repo.root) {
			reply(404, { error: "Report not found in this workspace" });
			return true;
		}
		return handleReportsRequest(req, url, repo.root, reply);
	}
	return handleDocsRequest(req, url, repo.root, reply);
}
