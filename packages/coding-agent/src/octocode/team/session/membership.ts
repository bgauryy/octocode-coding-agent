import path from "node:path";
import { activationId } from "../../shared/activation.ts";
import type { FeatureContext } from "../../../core/features/index.ts";
import { newMember } from "../identity.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { type TeamStore } from "../store.ts";
import { AGENT_ID_ENV } from "../store/env.ts";
import { namedParent } from "./parent.ts";
import type { SessionTeamName } from "./rejoin.ts";

/** Names drawn in turn when other processes keep taking them. */
const JOIN_ATTEMPTS = 8;

/**
 * Takes a name in the shared database: the one the parent chose for a subagent, else the name a resumed session recorded
 * (`recorded`) when free, else a free one (`newName`, given the names lost so far); `recorded` then keeps the name taken. Two processes can draw the same free name; the database gives it to the first, and the other
 * draws again (never overwrites the row).
 */
export function claimName(
	env: NodeJS.ProcessEnv,
	db: TeamStore,
	ctx: FeatureContext,
	goal: string | undefined,
	newName: (lost: string[]) => string,
	recorded?: SessionTeamName,
): Member {
	const sessionDir = ctx.sessionManager.getSessionDir?.();
	db.lifecycle = ctx.sessionManager.getSessionFile()
		? {
				activationId: activationId(ctx.sessionManager),
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				...(sessionDir ? { dir: path.resolve(sessionDir) } : {}),
			}
		: undefined;
	db.callbacks.sessionId = ctx.sessionManager.getSessionId();
	const chosen = env[AGENT_ID_ENV];
	const lost: string[] = [];
	for (let attempt = 0; attempt < JOIN_ATTEMPTS; attempt += 1) {
		// A running agent holding the recorded name keeps it: the next attempt draws a free one.
		const wish = chosen ?? (attempt === 0 ? recorded?.preferred : undefined);
		const member = newMember(env, ctx, wish ?? newName(lost), goal, Date.now());
		// A chosen name's row may be the one its parent holds for it with its reservations.
		if (db.join(member, chosen ? namedParent(env) : undefined)) {
			recorded?.joined(member.id);
			return member;
		}
		if (chosen) throw new Error(`The team name ${chosen} is held by another running agent.`);
		lost.push(member.id);
	}
	throw new Error("No free team name: the names kept being taken by other agents joining at the same time. Try again.");
}

/**
 * A session joins the team when it starts, so "on" means on for every agent: a subagent whose parent chose its
 * name must (a failure ends it); a main session joins best effort, because a team database that cannot be used
 * must not stop a session that never collaborates. It stays unjoined then, and its first team action joins again and reports
 * the same failure (`Team.problem`, `/agents` and the footer show a foreign database at once).
 */
export async function joinAtStart(env: NodeJS.ProcessEnv, join: () => Promise<unknown>): Promise<void> {
	if (env[AGENT_ID_ENV]) {
		await join();
		return;
	}
	try {
		await join();
	} catch {
		/* reported by the first team action; see above */
	}
}
