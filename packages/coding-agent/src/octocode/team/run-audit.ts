import type { AgentRun, ResolvedAgent, RunOutcome, RunStart } from "../../../../db/src/api.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { MemberDetails } from "./store/details.ts";
import type { TeamStore } from "./store.ts";
import type { EndReason } from "./session/end-reason.ts";

/** The team database as the audit uses it: opened on first write, never created by a read. */
interface AuditHost {
	store(): TeamStore;
	existing(): TeamStore | undefined;
}

/**
 * What a parent records about the agents it starts (`agent_runs`) and how anyone finds an agent again. The
 * writes are advisory: a team database that cannot be written leaves the agent to be audited by the row that retires it, so
 * they never fail the run they describe. The reads throw when the database is unusable, like every other read of the team.
 */
export class RunAudit {
	private readonly host: AuditHost;

	constructor(host: AuditHost) {
		this.host = host;
	}

	/** A child is about to start: opens its run (its parent, profile, model, goal and `item`, the number of the backlog item of this workspace it is for). */
	begin(start: Omit<RunStart, "workspaceId" | "backlog"> & { item?: number }): void {
		try {
			const store = this.host.store();
			const { item, ...run } = start;
			store.presence.beginRun(
				item === undefined ? run : { ...run, backlog: { workspaceId: store.workspaceId, seq: item } },
				store.workspaceId,
			);
		} catch {
			// The run is then audited from the child's own join and its end, without the parent's facts.
		}
	}

	/** The run of `agentId` is over: its outcome and exit, and its end when no row is left to retire. */
	finish(agentId: string, outcome: RunOutcome): void {
		try {
			this.host.existing()?.presence.finishRun(agentId, outcome);
		} catch {
			// The run keeps what its retirement wrote.
		}
	}

	/** The parent is ending child `id` for `hint`, before it aborts it: a child that dies without leaving is retired with that reason. */
	hint(id: string, hint: EndReason): void {
		try {
			this.host.existing()?.presence.hint(id, hint);
		} catch {
			// Nothing to repair: the hint only sharpens a reason.
		}
	}

	/** The runs that began last in this workspace, newest first (`agentId`: one agent's only). */
	recent(limit = 8, agentId?: string): AgentRun[] {
		const store = this.host.existing();
		return store?.presence.runs({ workspaceId: store.workspaceId, ...(agentId ? { agentId } : {}), limit }) ?? [];
	}

	/** The runs started for backlog item `seq` of `workspaceId`, newest first. */
	forItem(workspaceId: string, seq: number): AgentRun[] {
		return this.host.existing()?.presence.runsForItem(workspaceId, seq) ?? [];
	}

	/** What `coordinate list` adds per member: its backlog item, transcript and shell-log folders. */
	details(members: readonly Member[]): Map<string, MemberDetails> {
		const store = this.host.existing();
		return store?.presence.details(members, store.workspaceId) ?? new Map();
	}

	/** The agent `ref` names (name, session, registration or run id, process title, pid or backlog item), live or past. */
	resolve(ref: string): ResolvedAgent | undefined {
		const store = this.host.existing();
		return store?.presence.resolve(ref, store.workspaceId);
	}
}
