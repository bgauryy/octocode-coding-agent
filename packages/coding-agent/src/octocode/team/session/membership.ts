import { activationId } from "../../shared/activation.ts";
import type { ExtensionContext } from "../../../core/features/index.ts";
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
	ctx: ExtensionContext,
	goal: string | undefined,
	newName: (lost: string[]) => string,
	recorded?: SessionTeamName,
): Member {
	db.lifecycle = ctx.sessionManager.getSessionFile()
		? { activationId: activationId(ctx.sessionManager), sessionId: ctx.sessionManager.getSessionId() }
		: undefined;
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
