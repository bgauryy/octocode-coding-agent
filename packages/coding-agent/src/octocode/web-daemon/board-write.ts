import type { IncomingMessage } from "node:http";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { BacklogError, TaskError, type BacklogStore } from "../backlog/store.ts";
import { applyBoardWrite } from "../backlog/web-commands.ts";
import { readJsonBody } from "../shared/json-body.ts";
import type { Reply } from "./http-util.ts";

/**
 * `POST` on the board route through `applyBoardWrite`, the function the session's own server uses, so an edit is
 * recorded the same way on either page. Authentication, the Host and Origin checks and the view-link refusal already
 * ran in the daemon's request handler before any scoped route is reached, so a write arrives here only with a launch or
 * published-control token. `session` is the attached session of a `/s/<id>` scope; a `/r/<id>` scope has none.
 * Refusals carry the store's one-line message (redacted), and a version conflict carries the current copy, as in the
 * session server. `written` runs after a change was saved.
 */
export async function handleBoardWrite(
	req: IncomingMessage,
	store: BacklogStore,
	session: string | undefined,
	reply: Reply,
	written?: () => void,
): Promise<void> {
	const input = await readJsonBody(req, reply);
	if (input === undefined) return;
	try {
		const outcome = await applyBoardWrite(store, input, session);
		if (!outcome.ok) return reply(400, { error: outcome.error });
		reply(200, outcome.result);
		written?.();
	} catch (error) {
		reply(409, {
			error: error instanceof Error ? redactSecrets(error.message) : "Backlog change failed",
			...(error instanceof BacklogError && error.current ? { current: error.current } : {}),
			...(error instanceof TaskError && error.task ? { task: error.task } : {}),
		});
	}
}
