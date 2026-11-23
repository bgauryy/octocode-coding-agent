/**
 * Quota readings of the providers this process sends to (F3). Every chat request through the runtime (`requests.ts`)
 * reads the quota headers of its response (`parseQuotaHeaders`) through {@link quotaStep}; other producers (a CLI's
 * rate-limit event) call {@link ProviderQuotas.record}. This process keeps the latest reading per provider and window, so
 * its own views see a reading at once; the agent database (`provider_quota`) shares them with every other Octocode
 * process, which use the same credential per provider. Writes are throttled: at most one per provider per
 * {@link QUOTA_WRITE_INTERVAL_MS}, except at once when a plan window crosses 70, 90 or 100 % or its reset moves.
 *
 * Read API: `providerQuotas.current(provider)` and `providerQuotas.all()` give the readings in force (memory first,
 * then the database's for windows another process saw later); `providerQuotas.providers()` names the providers this
 * process recorded.
 */

import { parseQuotaHeaders, type ProviderResponse, type QuotaReading } from "@octocodeai/octocode-ai";
import { type AgentDb, providerQuota } from "../../../../db/src/api.ts";
import { sharedAgentDb, sharedAgentDbWriter } from "../../storage/database.ts";
import { recordProblem } from "../diagnostics-log.ts";

/** Where readings are shared with other processes. */
export interface QuotaStore {
	/** Every window stored for `provider`. */
	read(provider: string): QuotaReading[];
	/** Every reading taken at or after `since` (ms since the epoch). */
	readSince(since: number): QuotaReading[];
	/** Stores readings; one another process took later is kept. */
	write(readings: QuotaReading[]): Promise<void>;
}

/**
 * The agent database's quota rows. A read is one primary-key range (or a scan of a few rows) on the process's shared
 * connection; a write goes through the database writer, so a peer holding the write lock never stalls this thread.
 */
export function agentDbQuotaStore(env: NodeJS.ProcessEnv = process.env): QuotaStore {
	let agent: AgentDb | undefined;
	const db = () => {
		if (!agent?.db.isOpen) agent = sharedAgentDb(env);
		return agent.db;
	};
	return {
		read: (provider) => providerQuota.listByProvider(db(), provider),
		readSince: (since) => providerQuota.listFresh(db(), since),
		write: (readings) => sharedAgentDbWriter(env).post({ kind: "provider-quota", readings }),
	};
}

/** Longest gap between two database writes of one provider's readings while it keeps answering. */
export const QUOTA_WRITE_INTERVAL_MS = 30_000;
/** Plan-window marks whose crossing is written at once: the footer warns from 70 % and turns red from 90 %. */
const PLAN_MARKS = [0.7, 0.9, 1] as const;
/** A reset that moved less than this is the same reset (a window's reset time read with rounding). */
const RESET_SLACK_MS = 60_000;
/** How long a database read stays good for repeated views (a footer render, `/status`). */
const SHARED_READ_TTL_MS = 5_000;
/** A reading that names no reset describes its window for this long. */
const UNTIMED_READING_MS = 10 * 60_000;
/** The longest window a reading can describe (a week), with a day's margin: older rows are not read. */
const LONGEST_WINDOW_MS = 8 * 86_400_000;

/** Whether `reading` still describes its window at `now`: its reset is ahead, or it named none and is recent. */
function isCurrentReading(reading: QuotaReading, now: number): boolean {
	return reading.resetsAt !== undefined ? reading.resetsAt > now : now - reading.observedAt < UNTIMED_READING_MS;
}

const markOf = (fraction: number): number => PLAN_MARKS.filter((mark) => fraction >= mark).length;

/** Whether `next` must reach the database at once: a plan window that is new, crossed a mark, or reset at another time. */
function planChanged(previous: QuotaReading | undefined, next: QuotaReading): boolean {
	if (next.kind !== "plan") return false;
	if (!previous) return true;
	if (markOf(previous.usedFraction) !== markOf(next.usedFraction)) return true;
	if ((previous.resetsAt === undefined) !== (next.resetsAt === undefined)) return true;
	return Math.abs((previous.resetsAt ?? 0) - (next.resetsAt ?? 0)) > RESET_SLACK_MS;
}

/** Plan windows first, then by provider and window id. */
const byDisplayOrder = (a: QuotaReading, b: QuotaReading): number =>
	a.provider.localeCompare(b.provider) ||
	(a.kind === b.kind ? 0 : a.kind === "plan" ? -1 : 1) ||
	a.window.localeCompare(b.window);

/** The newer of each provider window's readings among `lists`, current at `now`. */
function newestCurrent(now: number, ...lists: Iterable<QuotaReading>[]): QuotaReading[] {
	const newest = new Map<string, QuotaReading>();
	for (const list of lists)
		for (const reading of list) {
			const key = `${reading.provider}\0${reading.window}`;
			const known = newest.get(key);
			if (!known || reading.observedAt > known.observedAt) newest.set(key, reading);
		}
	return [...newest.values()].filter((reading) => isCurrentReading(reading, now)).sort(byDisplayOrder);
}

/** This process's quota readings, joined with the shared store's. */
export class ProviderQuotas {
	/** provider → window → the latest reading this process took. */
	private readonly latest = new Map<string, Map<string, QuotaReading>>();
	/** When each provider's readings were last sent to the store. */
	private readonly writtenAt = new Map<string, number>();
	/** Store reads kept for {@link SHARED_READ_TTL_MS}: by provider, and `undefined` for the all-providers read. */
	private readonly sharedReads = new Map<string | undefined, { at: number; readings: QuotaReading[] }>();
	private store: QuotaStore | undefined;
	/** The store failed: told once per process, then this process keeps working from its own readings. */
	private reported = false;

	private readonly openStore: () => QuotaStore;
	readonly now: () => number;
	private readonly onStoreError: (error: unknown) => void;

	constructor(
		openStore: () => QuotaStore,
		now: () => number = () => Date.now(),
		onStoreError: (error: unknown) => void = (error) => recordProblem("provider-quota", error),
	) {
		this.openStore = openStore;
		this.now = now;
		this.onStoreError = onStoreError;
	}

	/** Records the readings a response of `provider` carries in its headers; nothing when it carries none. */
	recordHeaders(provider: string, headers: Record<string, string>): void {
		const readings = parseQuotaHeaders(provider, headers, this.now());
		if (readings.length > 0) this.record(readings);
	}

	/**
	 * Keeps each reading as its window's latest (an older one than this process holds is dropped) and sends each
	 * provider's windows to the store when its last write is {@link QUOTA_WRITE_INTERVAL_MS} old or a plan window changed.
	 */
	record(readings: readonly QuotaReading[]): void {
		const now = this.now();
		const changed = new Map<string, boolean>();
		for (const reading of readings) {
			let windows = this.latest.get(reading.provider);
			if (!windows) this.latest.set(reading.provider, (windows = new Map()));
			const previous = windows.get(reading.window);
			if (previous && previous.observedAt > reading.observedAt) continue;
			windows.set(reading.window, reading);
			changed.set(reading.provider, (changed.get(reading.provider) ?? false) || planChanged(previous, reading));
		}
		for (const [provider, planMoved] of changed) {
			const last = this.writtenAt.get(provider);
			if (!planMoved && last !== undefined && now - last < QUOTA_WRITE_INTERVAL_MS) continue;
			this.writtenAt.set(provider, now);
			const windows = [...(this.latest.get(provider)?.values() ?? [])];
			void this.shared((store) => store.write(windows))?.catch((error: unknown) => this.report(error));
		}
	}

	/** The readings in force for `provider`, plan windows first; empty when none is. */
	current(provider: string): QuotaReading[] {
		const shared = this.sharedRead(provider, (store) => store.read(provider));
		return newestCurrent(this.now(), this.latest.get(provider)?.values() ?? [], shared);
	}

	/** The readings in force for every provider, by provider with plan windows first. */
	all(): QuotaReading[] {
		const now = this.now();
		const shared = this.sharedRead(undefined, (store) => store.readSince(now - LONGEST_WINDOW_MS));
		const own = [...this.latest.values()].flatMap((windows) => [...windows.values()]);
		return newestCurrent(now, own, shared);
	}

	/** The providers this process took a reading of. */
	providers(): string[] {
		return [...this.latest.keys()];
	}

	private sharedRead(key: string | undefined, read: (store: QuotaStore) => QuotaReading[]): QuotaReading[] {
		const now = this.now();
		const kept = this.sharedReads.get(key);
		if (kept && now - kept.at < SHARED_READ_TTL_MS) return kept.readings;
		const readings = this.shared(read) ?? [];
		this.sharedReads.set(key, { at: now, readings });
		return readings;
	}

	/** Runs `use` on the shared store; a store that cannot open or answer is reported once and leaves this process's copy. */
	private shared<T>(use: (store: QuotaStore) => T): T | undefined {
		try {
			this.store ??= this.openStore();
			return use(this.store);
		} catch (error) {
			this.report(error);
			return undefined;
		}
	}

	private report(error: unknown): void {
		if (this.reported) return;
		this.reported = true;
		this.onStoreError(error);
	}
}

/** The process's quota readings, shared through the agent database. */
export const providerQuotas = new ProviderQuotas(() => agentDbQuotaStore());

type ResponseHook<TModel> = (response: ProviderResponse, model: TModel) => void | Promise<void>;

/**
 * The response hook of one request to `model`'s provider: it records the quota headers of the response, then runs the
 * caller's own `onResponse`, whose result (and failure) stays the request's. The transport calls it for every
 * response, a refusal included, before the body is read.
 */
export function quotaStep<TModel>(
	model: { provider: string },
	options: { onResponse?: ResponseHook<TModel> } | undefined,
	quotas: ProviderQuotas = providerQuotas,
): ResponseHook<TModel> {
	const { provider } = model;
	const hook = options?.onResponse;
	return (response, requestModel) => {
		quotas.recordHeaders(provider, response.headers);
		return hook?.(response, requestModel);
	};
}
