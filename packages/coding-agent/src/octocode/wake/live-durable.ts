import { randomUUID } from "node:crypto";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { DbEventStore } from "../events/loop/db-store.ts";
import { isDeduped, isDurable } from "../events/loop/cutover.ts";
import type { EventStore } from "../events/loop/store.ts";
import type { AgentEvent, PayloadEvent } from "../events/topics.ts";
import { prepareAgentDb, sharedAgentDb } from "../../storage/database.ts";
import { registeredWorkspaceWhenReady } from "../../storage/workspace-database.ts";
import { wakeCatalog } from "./loop-catalog.ts";
import type { Held, Message, SendOptions } from "./gate-types.ts";

/** How long a session's offset in the event log outlives its last start; a resume within it replays what was left. */
const OFFSET_TTL_MS = 14 * 24 * 3_600_000;

/** What names a session's store: its folder and id. */
export interface SessionOf {
	cwd: string;
	sessionManager: { getSessionId(): string };
}

/** The loop's store for a session: its events in the event log, its offset in a subscription of its own. */
export async function sessionStore(ctx: SessionOf, env: NodeJS.ProcessEnv = process.env): Promise<EventStore> {
	await prepareAgentDb(env);
	const agent = sharedAgentDb(env);
	const sessionId = ctx.sessionManager.getSessionId();
	return DbEventStore.open(agent, {
		workspaceId: (await registeredWorkspaceWhenReady(ctx.cwd, agent)).id,
		sessionId,
		// The subscription is unique per workspace and subscriber, so each session's offset is its own.
		subscriber: `loop:${sessionId}`,
		pid: process.pid,
		ttlMs: OFFSET_TTL_MS,
	});
}

/**
 * What the loop writes beside a durable wake, so a restarted session sends it again: the message exactly as the gate would
 * have sent it (its source header included), its options and the events it carries. A repeat of a report or mail the session
 * already took has the same key and is dropped.
 */
export function durableOf(
	events: readonly PayloadEvent[],
	held: Held,
	sessionId: string,
): { dedupeKey?: string; body?: Record<string, unknown> } {
	if (!events.every(isDurable)) return {};
	const entryId = randomUUID();
	held.entryId = entryId;
	const body = { entryId, message: held.message, options: held.options, events };
	if (!events.some(isDeduped)) return { body };
	return { body, dedupeKey: `${sessionId}:${events.map((event) => wakeCatalog.describe(event).key).join("|")}` };
}

/** A stored wake's events, message and options; a record the loop did not write is refused. */
export function replayOf(stored: AgentEvent): { events: PayloadEvent[]; message: Message; options: SendOptions } {
	const { body } = stored;
	if (!body || !isRecord(body.message) || !isRecord(body.options) || !Array.isArray(body.events))
		throw new Error(`stored event ${stored.seq} (${stored.topic}) has no message to send again`);
	return {
		events: body.events as PayloadEvent[],
		message: body.message as unknown as Message,
		options: body.options,
	};
}
