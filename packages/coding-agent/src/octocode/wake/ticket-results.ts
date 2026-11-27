import { sharedClock } from "@octocodeai/octocode-common/clock";
import type { FeatureSetup } from "../../core/features/index.ts";
import { recordProblem } from "../../core/diagnostics-log.ts";
import { workspaceDbWhenReady } from "../../storage/workspace-database.ts";
import { type AgentDb, isBusy, withoutWaiting } from "../../../../db/src/api.ts";
import { EventSubscribers } from "../events/subscribers.ts";
import { Tickets } from "../events/tickets.ts";
import type { AgentEvent, PayloadEvent } from "../events/topics.ts";
import type { WakeGate } from "./gate.ts";

/**
 * Delivers a callback ticket's result to the agent that asked (`events/tickets.ts`): the result is a `ticket.resolved` or
 * `ticket.rejected` row in the event log under the asker's session, written by whichever process settled the ticket. This
 * reads each such row once, from a stored offset, and hands it to the wake gate for the live loop to deliver. A resumed session reads on from its offset, so a result
 * that arrived while it was away is delivered once. The same timer expires overdue tickets and settles the tickets that
 * events the gate sees (reports, ends, item states, job exits) satisfy.
 */

const TICK_MS = 2_000;
const CUSTOM_TYPE = "octocode-ticket-result";
const OFFSET_TTL_MS = 14 * 24 * 3_600_000;

type Settled = PayloadEvent<"ticket.resolved" | "ticket.rejected">;

class TicketResults {
	private readonly tickets: Tickets;
	private readonly agent: AgentDb;
	private readonly subscribers: EventSubscribers;
	private readonly stops: Array<() => void> = [];
	private stopTimer: (() => void) | undefined;
	private ticking: Promise<void> | undefined;
	private readonly failed: (error: unknown) => void;

	constructor(
		agent: AgentDb,
		options: { workspaceId: string; sessionId: string; now?: () => number; failed?: (error: unknown) => void },
	) {
		const now = options.now ?? Date.now;
		const failed = options.failed ?? ((error: unknown) => void recordProblem("ticket-results", String(error)));
		this.agent = agent;
		this.tickets = new Tickets(agent, { ...options, now });
		this.subscribers = new EventSubscribers(agent, {
			...options,
			pid: process.pid,
			ttlMs: OFFSET_TTL_MS,
			now,
			failed: (hook, event, error) => failed(new Error(`${hook} event ${event.seq}: ${String(error)}`)),
		});
		this.failed = failed;
	}

	/**
	 * Expires overdue tickets, then delivers every result not yet delivered; calls overlap one at a time. The expiry
	 * transaction runs only while some ticket is pending; the delivery is an indexed read from the stored offset, so a
	 * ticket opened and settled between two ticks is still delivered.
	 */
	tick(): Promise<void> {
		return (this.ticking ??= Promise.resolve()
			.then(async () => {
				if (this.tickets.anyPending()) this.expireIfUnlocked();
				await this.subscribers.pump();
			})
			.finally(() => {
				this.ticking = undefined;
			}));
	}

	/** The expiry write never waits for another process's lock on the thread that draws the screen: a locked database retries it at the next tick. */
	private expireIfUnlocked(): void {
		try {
			withoutWaiting(this.agent.db, () => this.tickets.expire());
		} catch (error) {
			if (!isBusy(error)) throw error;
		}
	}

	/** Ticks every two seconds until `close`. The timer never keeps the process alive. */
	async start(gate: Pick<WakeGate, "emit" | "onEmit">, intervalMs = TICK_MS): Promise<void> {
		for (const topic of ["ticket.resolved", "ticket.rejected"] as const)
			this.stops.push(
				await this.subscribers.subscribe({
					hook: `ticket-results:${topic}`,
					topic,
					handle: (event) => deliver(gate, event as AgentEvent<"ticket.resolved" | "ticket.rejected">),
				}),
			);
		this.stops.push(
			gate.onEmit((events, sources) => {
				events.forEach((event, index) => {
					const { kind, ...payload } = event;
					const source = sources[index];
					if (source)
						this.tickets.resolveEvent({
							topic: kind,
							payload,
							source,
							digest: `${kind} ${JSON.stringify(payload).slice(0, 100)}`,
						});
				});
			}),
		);
		this.stopTimer ??= sharedClock.subscribe(
			() => {
				if (!this.ticking) void this.tick().catch(this.failed);
			},
			{ everyMs: intervalMs },
		);
	}

	async close(): Promise<void> {
		this.stopTimer?.();
		this.stopTimer = undefined;
		for (const stop of this.stops.splice(0)) stop();
		await this.subscribers.close();
		await this.ticking;
	}
}

/** A reply already woke the asker as a message; every other result starts a turn. */
async function deliver(
	gate: Pick<WakeGate, "emit">,
	event: AgentEvent<"ticket.resolved" | "ticket.rejected">,
): Promise<void> {
	const quiet = event.topic === "ticket.resolved" && event.payload.on === "reply";
	await gate.emit(
		{ kind: event.topic, ...event.payload } as Settled,
		{ customType: CUSTOM_TYPE, content: event.digest, display: true },
		{ triggerTurn: !quiet, deliverAs: "followUp" },
		!quiet,
		[event.source],
	);
}

/** Runs the session's ticket results from `session_start` to `session_shutdown`. */
export function installTicketResults(api: FeatureSetup, gate: WakeGate): void {
	let running: TicketResults | undefined;
	api.bus.on("session_start", async (_event, ctx) => {
		await running?.close();
		const { agent, workspace } = await workspaceDbWhenReady(ctx.cwd);
		running = new TicketResults(agent, {
			workspaceId: workspace.id,
			sessionId: ctx.sessionManager.getSessionId(),
		});
		try {
			await running.start(gate);
		} catch (error) {
			await running.close();
			throw error;
		}
	});
	api.bus.on("session_shutdown", async () => {
		const was = running;
		running = undefined;
		await was?.close();
	});
}
