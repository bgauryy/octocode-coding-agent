import { randomUUID } from "node:crypto";
import { type AgentDb, leases, meta } from "../../../../../db/src/api.ts";
import { DAY_MS, MINUTE_MS } from "../../shared/util.ts";
import type { MemoryFileRef } from "../../permission/memory-files.ts";

/**
 * The consolidation pass of one MEMORY.md runs at most once a day on the machine, and never twice at once: a lease in
 * the agent database (`leases`, keyed `memory:<file>` so no checkout's file reservation can equal it) holds the pass, and
 * a `meta` stamp records when the last one finished. Both are checked and taken in one transaction, so of two sessions
 * starting together one runs the pass and the other skips it.
 */

/** Longer than any pass takes (its model call times out sooner); a crashed pass frees the file when it lapses. */
const PASS_LEASE_MS = 10 * MINUTE_MS;
const PASS_INTERVAL_MS = DAY_MS;

const leaseKey = (file: MemoryFileRef): string => `memory:${file.path}`;
const stampKey = (file: MemoryFileRef): string => `memory_consolidated:${file.path}`;

export type ConsolidationClaim =
	| {
			ok: true;
			/** Ends the pass: `finished` records it, so the next one waits a day; an aborted pass leaves no record. */
			release(finished: boolean, now?: number): void;
	  }
	| { ok: false; why: "running" | "done today" };

/** Takes `file`'s pass for this process, or says why not. `workspaceId` is the session's registered workspace. */
export function claimConsolidation(
	agentDb: AgentDb,
	workspaceId: string,
	file: MemoryFileRef,
	now = Date.now(),
): ConsolidationClaim {
	const owner = `memory-pass:${process.pid}:${randomUUID()}`;
	const why = agentDb.transaction((): "running" | "done today" | undefined => {
		const last = meta.read(agentDb.db, stampKey(file));
		if (last !== undefined && now - Number(last) < PASS_INTERVAL_MS) return "done today";
		if (leases.liveOnKey(agentDb.db, leaseKey(file), now)) return "running";
		leases.insert(
			agentDb.db,
			workspaceId,
			owner,
			{ path: file.path, pathKey: leaseKey(file), kind: "file", reason: "memory consolidation" },
			now,
			now + PASS_LEASE_MS,
		);
		return undefined;
	});
	if (why) return { ok: false, why };
	return {
		ok: true,
		release: (finished, at = Date.now()) =>
			agentDb.transaction(() => {
				if (finished) meta.write(agentDb.db, stampKey(file), String(at));
				leases.releaseByOwner(agentDb.db, owner);
			}),
	};
}
