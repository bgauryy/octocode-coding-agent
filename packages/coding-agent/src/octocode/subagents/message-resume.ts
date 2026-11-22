import { sessionChildren } from "../child-sessions/session-children.ts";
import { USER_SENDER } from "../shared/messages.ts";
import type { Resumer, ResumeRequest } from "../team/session/send.ts";
import { followUpText } from "./follow-up.ts";
import { spawnAgent } from "./spawn.ts";
import type { SpawnEnv } from "./spawn-env.ts";

/** The parent or the user asks, and the message is theirs (written or passed on by them), not a peer's relayed one. */
function ownDecision(parentId: string | undefined, from: string, request: ResumeRequest | undefined): boolean {
	if (from !== USER_SENDER && (parentId === undefined || from !== parentId)) return false;
	return !request || request.message.from === from || request.message.forwardedBy === from;
}

/**
 * The team's resumer. A message to a lingering run revives it (`env.lingering`). Otherwise a message the parent or
 * the user sends to a finished child of this session that ran in this tree starts the resume `agent` `task` with
 * `resume` starts (`spawnAgent`: the same permission prompt, slot limit and item rules), in the background, with the
 * stored message as its follow-up. Undefined, so the sender gets its refusal, for an isolated or unknown child or a
 * message the parent or user did not write or pass on.
 */
export function messageResumer(env: SpawnEnv): Resumer {
	const launching = new Set<string>();
	return async (id, text, from, signal, request) => {
		const revived = await env.lingering.resume(id, text, from, signal, request);
		if (revived !== undefined) return revived;
		const ctx = env.lingering.context;
		const parentId = env.runs.team.id;
		if (!ctx || !ownDecision(parentId, from, request)) return undefined;
		const child = sessionChildren(ctx.sessionManager.getEntries()).find((candidate) => candidate.id === id);
		// An isolated child resumes in a recreated worktree, which only an explicit `task` `resume` decides; a runner's
		// conversation lives in its vendor CLI.
		if (!child || child.isolated || child.runner) return undefined;
		if (launching.has(id)) throw new Error(`${id} is already awaiting permission to resume.`);
		launching.add(id);
		try {
			const task = followUpText(text, from, parentId, request);
			const params = { task, resume: id, background: true };
			const result = await spawnAgent(
				env,
				`message-resume:${id}`,
				params,
				signal,
				undefined,
				ctx,
				request !== undefined,
			);
			const started = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			// A refused or failed start (permission denied, no saved conversation): the sender sees why, the stored row goes.
			if (result.isError) throw new Error(started);
			return `${result.details?.queued ? "Queued the resume of" : "Resumed"} ${id} with your message. ${started}`;
		} finally {
			launching.delete(id);
		}
	};
}
