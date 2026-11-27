import { HOUR_MS } from "../../shared/util.ts";

/** An agent that has not refreshed its row for this long is hidden from `list` (a stalled process: suspended, or on a machine that slept). Only its process ending, or it leaving, drops the row and its mail. */
export const STALE_MS = 60_000;
/** A member that runs but has been silent this long is named as stalled by `coordinate list` (a shorter silence is a suspended laptop or a busy process: it stays hidden). */
export const STALLED_LISTED_MS = 10 * 60_000;
/** Leases live this long past the owner's last heartbeat, so a crashed owner frees its files quickly. */
export const LEASE_MS = 90_000;
export const MESSAGE_RETENTION_MS = 24 * HOUR_MS;
export const INBOX_BATCH_SIZE = 32;
export const PRUNE_INTERVAL_MS = 60_000;

/** A member has not heartbeat for `STALE_MS`: its process may only be stalled, so it is hidden but keeps its mail and row. */
export const stale = (seenAt: number, now: number): boolean => now - seenAt > STALE_MS;

/**
 * Busy wait for a background write or read (heartbeat, delivery, the ticker's view): none, so the thread that draws the
 * screen never waits for another process's lock; a locked database is retried on the next tick instead.
 */
export const QUICK_BUSY_MS = 0;
/** First and longest pause between the attempts of `TeamStore.patiently`, which never wait inside SQLite. */
export const PATIENT_PAUSE_MS = { first: 5, max: 50 };
/** Busy wait for a write an agent asked for (a lock, a message). */
export const BUSY_MS = 5_000;
