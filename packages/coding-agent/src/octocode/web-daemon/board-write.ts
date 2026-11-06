import type { IncomingMessage } from "node:http";
import { Value } from "typebox/value";
import { BacklogCommandSchema, BacklogMutationSchema } from "@octocodeai/octocode-contracts/protocol";
import { USER_AUTHOR } from "../../../../db/src/api.ts";
import { redactSecrets } from "../../../../common/src/sanitize.ts";
import { BacklogError, TaskError, type BacklogStore } from "../backlog/store.ts";
import { applyBacklogCommand, applyBacklogMutation, mutationShapeError } from "../backlog/web-commands.ts";
import { readJsonBody, type Reply } from "./http-util.ts";

/**
 * `POST` on the board route: the same two body forms the session's own web server takes (a typed hierarchy command, or
 * an add/update/comment), applied by the same store functions as the user. Authentication, the Host and Origin checks
 * and the view-link refusal already ran in the daemon's request handler before any scoped route is reached, so a write
 * arrives here only with a launch or published-control token. `session` is the attached session of a `/s/<id>` scope;
 * a `/r/<id>` scope has none, so a task cannot be added to "the session" there and must name its item or session.
 * Refusals carry the store's one-line message (redacted), and a version conflict carries the current copy, as in the
 * session server.
 */
export async function handleBoardWrite(
	req: IncomingMessage,
	store: BacklogStore,
	session: string | undefined,
	reply: Reply,
): Promise<void> {
	const input = await readJsonBody(req, reply);
	if (input === undefined) return;
	try {
		if (typeof input === "object" && input !== null && "command" in input) {
			if (!Value.Check(BacklogCommandSchema, input)) return reply(400, { error: "Invalid backlog command" });
			if (session === undefined && input.command === "task.add" && !input.item && !input.session)
				return reply(400, { error: "Name the item or the session the task belongs to." });
			return reply(200, applyBacklogCommand(store, input, session ?? ""));
		}
		if (!Value.Check(BacklogMutationSchema, input)) return reply(400, { error: "Invalid backlog fields" });
		const shapeError = mutationShapeError(input);
		if (shapeError) return reply(400, { error: shapeError });
		const actor = { id: session ?? USER_AUTHOR, surface: "tool" as const };
		return reply(200, applyBacklogMutation(store, input, { actor, session }));
	} catch (error) {
		reply(409, {
			error: error instanceof Error ? redactSecrets(error.message) : "Backlog change failed",
			...(error instanceof BacklogError && error.current ? { current: error.current } : {}),
			...(error instanceof TaskError && error.task ? { task: error.task } : {}),
		});
	}
}
