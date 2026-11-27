import type { AgentRun, ResolvedAgent, RunOutcome, RunStart } from "../../../../db/src/api.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { MemberDetails } from "./store/details.ts";
import type { TeamStore } from "./store.ts";
import type { EndReason } from "./session/end-reason.ts";
import { busy, patiently } from "./store/patient.ts";

/** The team database as the audit uses it: opened on first write, never created by a read. */
interface AuditHost {
	store(): TeamStore;
	existing(): TeamStore | undefined;
}

/**
 * What a parent records about the agents it starts (`agent_runs`) and how anyone finds an agent again. The
 * writes are advisory: a team database that cannot be written leaves the agent to be audited by the row that retires it, so
 * they never fail the run they describe. Each is tried at once; while another process holds the write lock it queues,
 * in call order, and waits on timers (`patiently`), so the caller never blocks. The reads throw when the database is unusable, like every
 * other read of the team.
 */
export class RunAudit {
	private readonly host: AuditHost;
	/** The last queued write; each next one starts after it, so a run's end never lands before its start. */
	private queue: Promise<void> = Promise.resolve();
	private queued = 0;

	constructor(host: AuditHost) {
		this.host = host;
	}

	/** Queues `write` on `store` (resolved now, so a write never reopens a database released meanwhile). */
	private later(store: TeamStore | undefined, write: (store: TeamStore) => unknown): void {
		if (!store) return;
		if (this.queued === 0)
			try {
				store.quick(() => write(store));
				return;
			} catch (error) {
				// Advisory: a database that cannot be written leaves the run to what its own join and retirement write.
				if (!busy(error)) return;
			}
		this.queued++;
		this.queue = this.queue
			.then(() => patiently(store, () => write(store)))
			.then(
				() => undefined,
				// Still busy after the usual wait, or closed: the run keeps what its join and retirement write.
				() => undefined,
			)
			.finally(() => {
				this.queued--;
			});
	}

	/** Resolves once every write queued so far has landed or been given up. */
	settled(): Promise<void> {
		return this.queue;
	}

	/** A child is about to start: opens its run (its parent, profile, model, goal and `item`, the number of the backlog item of this workspace it is for). */
	begin(start: Omit<RunStart, "workspaceId" | "backlog"> & { item?: number }): void {
		let store: TeamStore;
		try {
			store = this.host.store();
		} catch {
			// The run is then audited from the child's own join and its end, without the parent's facts.
			return;
		}
		const { item, ...run } = start;
		const row = item === undefined ? run : { ...run, backlog: { workspaceId: store.workspaceId, seq: item } };
		this.later(store, (open) => open.presence.beginRun(row, open.workspaceId));
	}

	/** The run of `agentId` is over: its outcome and exit, and its end when no row is left to retire. */
	finish(agentId: string, outcome: RunOutcome): void {
		this.later(this.host.existing(), (open) => open.presence.finishRun(agentId, outcome));
	}

	/** The parent is ending child `id` for `hint`, before it aborts it: a child that dies without leaving is retired with that reason. */
	hint(id: string, hint: EndReason): void {
		this.later(this.host.existing(), (open) => open.presence.hint(id, hint));
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
