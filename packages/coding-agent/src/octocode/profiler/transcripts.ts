import fs from "node:fs";
import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { ProfilerMember } from "./service.ts";
import { resolveAgent, sessions, type Db } from "../../../../db/src/api.ts";

/** What a team row says about an agent, as the profiler lists it. */
export function agentBase(member: Member): ProfilerMember {
	return {
		joinedAt: member.joinedAt,
		updatedAt: member.updatedAt,
		...(member.outcome ? { outcome: member.outcome } : {}),
		...(member.waiting ? { waiting: member.waiting } : {}),
		...(member.activity ? { activity: member.activity } : {}),
		id: member.id,
		role: member.role,
		status: member.status === "working" ? "working" : "idle",
		...(member.parentId ? { parentId: member.parentId } : {}),
		...(member.model ? { model: member.model } : {}),
		...(member.goal ? { goal: member.goal } : {}),
	};
}

/**
 * The transcript of a team member. The session row the team database records for its session id is the authority (its
 * `file`, else the session folder holding `<timestamp>_<id>.jsonl`); a child saves under its scratch folder, which
 * the row points at. Undefined when nothing was recorded or the file is gone, as for an agent that is not an Octocode process.
 */
export function memberTranscript(db: Db, member: { id: string; sessionId?: string }): string | undefined {
	const resolved = resolveAgent(db, member.id);
	if (resolved?.sessionFile && fs.existsSync(resolved.sessionFile)) return resolved.sessionFile;
	const id = member.sessionId ?? resolved?.sessionId;
	return id ? sessionTranscript(db, id) : undefined;
}

/** The transcript of session `id` by the folder its session row records (`<timestamp>_<id>.jsonl`); undefined when the row or the file is missing. */
export function sessionTranscript(db: Db, id: string): string | undefined {
	const dir = sessions.byId(db, id)?.dir;
	if (!dir) return undefined;
	try {
		const name = fs.readdirSync(dir).find((entry) => entry.endsWith(`_${id}.jsonl`));
		return name ? path.join(dir, name) : undefined;
	} catch {
		return undefined;
	}
}
