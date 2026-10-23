import { HOUR_MS } from "../../shared/util.ts";

/** An agent that has not refreshed its row for this long is hidden from `list` (a stalled process: suspended, or on a machine that slept). Only its process ending, or it leaving, drops the row and its mail. */
export const STALE_MS = 60_000;
/** Leases live this long past the owner's last heartbeat, so a crashed owner frees its files quickly. */
export const LEASE_MS = 90_000;
export const MESSAGE_RETENTION_MS = 24 * HOUR_MS;
export const INBOX_BATCH_SIZE = 32;
export const PRUNE_INTERVAL_MS = 60_000;

/** A member has not heartbeat for `STALE_MS`: its process may only be stalled, so it is hidden but keeps its mail and row. */
export const stale = (seenAt: number, now: number): boolean => now - seenAt > STALE_MS;

/** SQLite's "database is locked" (`SQLITE_BUSY`, extended codes included). */
export const isBusy = (error: unknown): boolean => (Number((error as { errcode?: unknown }).errcode) & 0xff) === 5;

/** Busy wait for a background write (heartbeat, delivery): a locked database is retried on the next tick instead. */
export const QUICK_BUSY_MS = 100;
/** Busy wait for a write an agent asked for (a lock, a message). */
export const BUSY_MS = 5_000;
