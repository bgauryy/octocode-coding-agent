import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sharedAgentDb } from "../../../storage/database.ts";
import { deleteSessionsById } from "../../../octocode/sessions/delete.ts";
import {
	blockerText,
	databaseBytes,
	executePurge,
	planPurge,
	previewLines,
	resultLines,
} from "../../../octocode/sessions/purge.ts";
import { SessionIndex } from "../../../octocode/sessions/store.ts";
import type { RpcCommand, RpcResponse } from "../rpc-types.ts";
import { error, success } from "./responses.ts";
import type { AgentSession } from "../../../core/agent-session.ts";

/** What these handlers read from the running RPC mode (a subset of `RpcCommandHost`). */
interface DeleteHost {
	readonly session: AgentSession;
}

type Command<T extends RpcCommand["type"]> = Extract<RpcCommand, { type: T }>;

/** `delete_sessions`: the picker's removal (current and running sessions refused), by session id. */
export async function handleDeleteSessions(
	host: DeleteHost,
	command: Command<"delete_sessions">,
): Promise<RpcResponse> {
	try {
		const result = await deleteSessionsById(
			new SessionIndex(sharedAgentDb()),
			command.sessionIds,
			host.session.sessionId,
		);
		return success(command.id, "delete_sessions", result);
	} catch (cause) {
		return error(command.id, "delete_sessions", `Could not delete sessions: ${errorMessage(cause)}`);
	}
}

/**
 * `purge`: the `/purge` operation. `confirm: false` deletes nothing and returns the preview; `true` deletes after the same
 * live-process check as the command. The scope word is the schema's, so a typo cannot reach this handler.
 */
export async function handlePurge(host: DeleteHost, command: Command<"purge">): Promise<RpcResponse> {
	try {
		const index = new SessionIndex(sharedAgentDb());
		const options = { cwd: host.session.sessionManager.getCwd(), current: host.session.sessionId };
		if (!command.confirm) {
			const plan = await planPurge(index, command.scope, options);
			const refused = blockerText(plan);
			return success(command.id, "purge", {
				purged: false,
				lines: previewLines(plan, databaseBytes(index)),
				...(refused ? { refused } : {}),
			});
		}
		const outcome = await executePurge(index, command.scope, options);
		if ("refused" in outcome)
			return success(command.id, "purge", { purged: false, lines: [], refused: outcome.refused });
		return success(command.id, "purge", { purged: true, lines: resultLines(outcome.result), result: outcome.result });
	} catch (cause) {
		return error(command.id, "purge", `Purge failed: ${errorMessage(cause)}`);
	}
}
