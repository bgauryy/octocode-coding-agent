import type { DatabaseSync } from "node:sqlite";
import { keptStatement } from "../statements.ts";
import { inTransaction } from "./transaction.ts";

/** Length of a reservation window, ms. */
const WINDOW_MS = 60_000;
/** Settled reservations (actual tokens known) in windows older than this before `now` are deleted by writes. */
const KEEP_MS = 2 * WINDOW_MS;
/** Unreconciled reservations stay this long, since a provider stream can outlive its window; then they are stale. */
const PENDING_KEEP_MS = 15 * 60_000;
/** Rows one write deletes at most, so a long idle gap cannot stall a request. */
const PRUNE_BATCH = 200;
const MIN_SCALE = 0.1;
const SCALE_STEP = 0.1;
const SUCCESSES_PER_STEP = 5;

/** Tokens and requests reserved in one key's window; `tokens` counts the actual figure where one was reconciled. */
export interface ThroughputUsage {
	tokens: number;
	requests: number;
}

/** What `reserve` is asked: a window's capacity for `key` and the request's estimate. */
export interface ThroughputReserveInput {
	/** Model and Region. */
	key: string;
	reservationId: string;
	/** Start of the one-minute window, ms since the epoch. */
	windowStart: number;
	now: number;
	estimatedTokens: number;
	/** Tokens per minute before the key's adaptive scale and `utilization`. */
	tokenLimit: number;
	/** Requests per minute before the key's adaptive scale and `utilization`; omitted: no request cap, tokens only. */
	requestLimit?: number;
	/** Share of the capacity the caller may use, above 0 up to 1 (default 1); background callers leave headroom. */
	utilization?: number;
}

export type ThroughputReserveResult =
	| { admitted: true; effectiveTokenLimit: number; effectiveRequestLimit?: number; usage: ThroughputUsage }
	| {
			admitted: false;
			effectiveTokenLimit: number;
			effectiveRequestLimit?: number;
			usage: ThroughputUsage;
			/** When the oldest counted request expires and capacity can return, ms since the epoch. */
			retryAt: number;
	  };

/** A key's adaptive capacity state. */
export interface ThroughputState {
	/** Capacity multiplier, `0.1` to `1`. */
	scale: number;
	/** Successes since the last throttle or scale increase. */
	successes: number;
}

const RESERVATIONS = "provider_throughput_reservations";

function int(name: string, value: number, min: number): number {
	if (!Number.isSafeInteger(value) || value < min)
		throw new RangeError(`${name} must be an integer of at least ${min}`);
	return value;
}

function validKey(key: string): string {
	if (typeof key !== "string" || key === "") throw new RangeError("key must be a non-empty string");
	return key;
}

function validId(id: string): string {
	if (typeof id !== "string" || id === "") throw new RangeError("reservationId must be a non-empty string");
	return id;
}

function validUtilization(value: number | undefined): number {
	if (value === undefined) return 1;
	if (!(value > 0 && value <= 1)) throw new RangeError("utilization must be above 0 and at most 1");
	return value;
}

interface StateRow {
	scale: number;
	successes: number;
}

function readState(db: DatabaseSync, key: string): ThroughputState {
	const row = keptStatement(db, "SELECT scale, successes FROM provider_throughput_state WHERE key = ?").get(key) as
		| StateRow
		| undefined;
	return row ? { scale: row.scale, successes: row.successes } : { scale: 1, successes: 0 };
}

function writeState(db: DatabaseSync, key: string, state: ThroughputState, now: number): void {
	keptStatement(
		db,
		`INSERT INTO provider_throughput_state (key, scale, successes, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET scale = excluded.scale, successes = excluded.successes, updated_at = excluded.updated_at`,
	).run(key, state.scale, state.successes, now);
}

function readUsage(db: DatabaseSync, key: string, windowStart: number): ThroughputUsage {
	const row = keptStatement(
		db,
		`SELECT COALESCE(SUM(COALESCE(actual_tokens, estimated_tokens)), 0) AS tokens, COUNT(*) AS requests
		FROM ${RESERVATIONS} WHERE key = ? AND window_start = ?`,
	).get(key, windowStart) as { tokens: number; requests: number };
	return { tokens: row.tokens, requests: row.requests };
}

function prune(db: DatabaseSync, now: number): void {
	keptStatement(
		db,
		`DELETE FROM ${RESERVATIONS} WHERE rowid IN
			(SELECT rowid FROM ${RESERVATIONS}
			WHERE window_start < ? OR (actual_tokens IS NOT NULL AND window_start < ?) LIMIT ${PRUNE_BATCH})`,
	).run(now - PENDING_KEEP_MS, now - KEEP_MS);
}

/**
 * Reserves `estimatedTokens` and one request against the last 60 seconds for this key, atomically across connections and processes: the
 * capacity is the limit times the key's adaptive scale and `utilization`, at least 1. A request that would pass either
 * capacity is refused until at least `retryAt`, except that an entirely empty window admits one over-limit
 * reservation so a large request cannot starve. Reserving an id already held in the window admits without counting twice.
 */
export function reserve(db: DatabaseSync, input: ThroughputReserveInput): ThroughputReserveResult {
	const key = validKey(input.key);
	const reservationId = validId(input.reservationId);
	const windowStart = int("windowStart", input.windowStart, 0);
	const now = int("now", input.now, 0);
	const estimated = int("estimatedTokens", input.estimatedTokens, 0);
	const tokenLimit = int("tokenLimit", input.tokenLimit, 1);
	const requestLimit = input.requestLimit === undefined ? undefined : int("requestLimit", input.requestLimit, 1);
	const utilization = validUtilization(input.utilization);
	return inTransaction(db, () => {
		prune(db, now);
		const factor = readState(db, key).scale * utilization;
		const effectiveTokenLimit = Math.max(1, Math.floor(tokenLimit * factor));
		const effectiveRequestLimit =
			requestLimit === undefined ? undefined : Math.max(1, Math.floor(requestLimit * factor));
		// Only the current and preceding storage buckets intersect the rolling minute.
		const recent = keptStatement(
			db,
			`SELECT COALESCE(SUM(COALESCE(actual_tokens, estimated_tokens)), 0) AS tokens,
				COUNT(*) AS requests, MIN(created_at) AS oldest
			FROM ${RESERVATIONS} WHERE key = ? AND window_start BETWEEN ? AND ? AND created_at > ?`,
		).get(key, windowStart - WINDOW_MS, windowStart, now - WINDOW_MS) as {
			tokens: number;
			requests: number;
			oldest: number | null;
		};
		const usage = { tokens: recent.tokens, requests: recent.requests };
		const held = keptStatement(
			db,
			`SELECT 1 AS held FROM ${RESERVATIONS} WHERE key = ? AND window_start = ? AND reservation_id = ?`,
		).get(key, windowStart, reservationId);
		const fits =
			(effectiveRequestLimit === undefined || usage.requests + 1 <= effectiveRequestLimit) &&
			usage.tokens + estimated <= effectiveTokenLimit;
		if (!held && !fits && usage.requests > 0) {
			return {
				admitted: false,
				effectiveTokenLimit,
				effectiveRequestLimit,
				usage,
				retryAt: (recent.oldest ?? now) + WINDOW_MS,
			};
		}
		if (held) return { admitted: true, effectiveTokenLimit, effectiveRequestLimit, usage };
		keptStatement(
			db,
			`INSERT INTO ${RESERVATIONS} (key, window_start, reservation_id, estimated_tokens, actual_tokens, created_at)
			VALUES (?, ?, ?, ?, NULL, ?)`,
		).run(key, windowStart, reservationId, estimated, now);
		return {
			admitted: true,
			effectiveTokenLimit,
			effectiveRequestLimit,
			usage: { tokens: usage.tokens + estimated, requests: usage.requests + 1 },
		};
	});
}

/**
 * Replaces the reservation's token estimate with the `actualTokens` the response used (0 frees the tokens); the
 * request stays counted. Returns whether the reservation existed (pruned or released ones do not).
 */
export function reconcile(
	db: DatabaseSync,
	input: { key: string; windowStart: number; reservationId: string; actualTokens: number },
): boolean {
	const result = keptStatement(
		db,
		`UPDATE ${RESERVATIONS} SET actual_tokens = ? WHERE key = ? AND window_start = ? AND reservation_id = ?`,
	).run(
		int("actualTokens", input.actualTokens, 0),
		validKey(input.key),
		int("windowStart", input.windowStart, 0),
		validId(input.reservationId),
	);
	return Number(result.changes) > 0;
}

/** Deletes a reservation whose request never reached the transport, freeing its tokens and request. Returns whether it existed. */
export function release(db: DatabaseSync, input: { key: string; windowStart: number; reservationId: string }): boolean {
	const result = keptStatement(
		db,
		`DELETE FROM ${RESERVATIONS} WHERE key = ? AND window_start = ? AND reservation_id = ?`,
	).run(validKey(input.key), int("windowStart", input.windowStart, 0), validId(input.reservationId));
	return Number(result.changes) > 0;
}

/** Halves the key's capacity scale (not below 0.1) and resets its success count, atomically. */
export function recordThrottle(db: DatabaseSync, key: string, now: number): ThroughputState {
	validKey(key);
	const at = int("now", now, 0);
	return inTransaction(db, () => {
		const next = { scale: Math.max(MIN_SCALE, readState(db, key).scale / 2), successes: 0 };
		writeState(db, key, next, at);
		return next;
	});
}

/** Breaks a recovery streak after an ordinary provider failure without reducing capacity. */
export function recordFailure(db: DatabaseSync, key: string, now: number): ThroughputState {
	validKey(key);
	const at = int("now", now, 0);
	return inTransaction(db, () => {
		const next = { scale: readState(db, key).scale, successes: 0 };
		writeState(db, key, next, at);
		return next;
	});
}

/** Counts a success; the fifth in a row raises the scale by 0.1 (at most 1) and restarts the count, atomically. */
export function recordSuccess(db: DatabaseSync, key: string, now: number): ThroughputState {
	validKey(key);
	const at = int("now", now, 0);
	return inTransaction(db, () => {
		const state = readState(db, key);
		const successes = state.successes + 1;
		const next =
			successes >= SUCCESSES_PER_STEP
				? { scale: Math.min(1, Math.round((state.scale + SCALE_STEP) * 1e6) / 1e6), successes: 0 }
				: { scale: state.scale, successes };
		writeState(db, key, next, at);
		return next;
	});
}

/** The key's adaptive state for diagnostics: scale 1 and no successes when none was recorded. */
export function state(db: DatabaseSync, key: string): ThroughputState {
	return readState(db, validKey(key));
}

/** The key's reserved tokens and requests in `windowStart`'s window, for diagnostics. */
export function usage(db: DatabaseSync, key: string, windowStart: number): ThroughputUsage {
	return readUsage(db, validKey(key), int("windowStart", windowStart, 0));
}
