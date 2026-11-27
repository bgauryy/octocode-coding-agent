import type { AgentDb } from "../../../../../db/src/api.ts";
import { Tickets } from "../../events/tickets.ts";

/**
 * The callback tickets of one team workspace as this process uses them: requested and settled as the session that joined
 * (`sessionId`, set when it does), so a result lands in the requester's lane whichever process settles the ticket.
 */
export class TicketHandle {
	readonly agent: AgentDb;
	readonly workspaceId: string;
	/** The session that joined; tickets opened now belong to it. */
	sessionId: string | undefined;
	private current: { session: string | undefined; tickets: Tickets } | undefined;

	constructor(agent: AgentDb, workspaceId: string) {
		this.agent = agent;
		this.workspaceId = workspaceId;
	}

	tickets(): Tickets {
		if (this.current?.session !== this.sessionId || !this.current)
			this.current = {
				session: this.sessionId,
				tickets: new Tickets(this.agent, {
					workspaceId: this.workspaceId,
					...(this.sessionId ? { sessionId: this.sessionId } : {}),
				}),
			};
		return this.current.tickets;
	}

	/** Inside a leave's transaction: when `left` is true the agent's tickets settle (asked: cancelled, asked of it: rejected as `left`). */
	afterLeave(left: boolean, id: string): boolean {
		if (left) this.tickets().leave(id);
		return left;
	}
}
