import type { IncomingMessage } from "node:http";
import { WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { backlogSnapshot } from "../backlog/snapshot.ts";
import { isFolderTrusted } from "../trust/port.ts";
import { handleDocsRequest } from "../workspace/docs.ts";
import { handleReportsRequest } from "../workspace/reports.ts";
import { handleBoardWrite } from "./board-write.ts";
import type { Reply } from "./http-util.ts";
import type { RepoCatalog, RepoInfo } from "./repos.ts";

/**
 * The routes both scopes share: the repository's board (read, and written through `handleBoardWrite`), audit and saved
 * reports and documents (read-only). `self` is the attached session (its claims show as live). Returns true when the
 * request was answered. Token, Host and Origin checks ran before this is reached.
 */
export async function handleRepoRequest(
	req: IncomingMessage,
	url: URL,
	repo: RepoInfo,
	catalog: RepoCatalog,
	self: string | undefined,
	reply: Reply,
): Promise<boolean> {
	const store = () => catalog.store(repo.id);
	if (url.pathname === WORKSPACE_ROUTES.backlogs) {
		if (req.method === "POST") {
			await handleBoardWrite(req, store(), self, reply);
			return true;
		}
		if (req.method !== "GET") {
			reply(405, { error: "Method not allowed" });
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
			if (url.pathname === WORKSPACE_ROUTES.reports) reply(200, { reports: [] });
			else reply(404, { error: "Report not found in this workspace" });
			return true;
		}
		return handleReportsRequest(req, url, repo.root, reply);
	}
	return handleDocsRequest(req, url, repo.root, reply, isFolderTrusted);
}
