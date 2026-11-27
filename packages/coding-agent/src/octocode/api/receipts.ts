import { ERR, RpcError } from "./protocol.ts";

/** What a settled run hands to `wait` callers: the final assistant text, why the run ended and, when it failed, the reason. */
export type RunResult = {
	text: string;
	stopReason?: string;
	errorMessage?: string;
};

/** An error, an abort or a reply cut at the output limit is not a result a script should treat as success. */
export function runSucceeded(result: Pick<RunResult, "stopReason">): boolean {
	return result.stopReason === undefined || result.stopReason === "stop" || result.stopReason === "toolUse";
}

interface Waiter {
	resolve(result: RunResult): void;
	reject(error: Error): void;
}

/**
 * One `message.send`: `preparing` (the message is being reviewed and nothing is sent), `accepted` (sent to the session,
 * its run still going), `settled` (that run ended), `uncertain` (the send itself failed after dispatch) or `cancelled`.
 */
export interface SendReceipt {
	phase: "preparing" | "accepted" | "uncertain" | "cancelled" | "settled";
	/** Still preparing because the session's user is deciding whether to let the message in. */
	waitingForUser?: boolean;
	/** The asynchronous host handoff failed after an acknowledgement; retries must not dispatch again. */
	failure?: Error;
	reject(error: Error): void;
	/** Where the keyed receipt is stored, when it is. */
	durable?: { sessionId: string; key: string };
	controller: AbortController;
	ready: Promise<void>;
	fingerprint: string;
	/** Who sent it (`callerOwner`): only that caller may cancel it or abort its run by key. */
	owner?: string;
	accepted: { id: string; queued: string };
	settlement: Promise<RunResult>;
	/** Resolves `ready` once the message is dispatched. */
	resolveReady(): void;
}

/** Where keyed receipts outlive the process, so a retry after a restart learns what became of its message. */
export interface ReceiptStore {
	save(sessionId: string, key: string, row: Omit<StoredReceipt, "updatedAt">): void;
	setPhase(sessionId: string, key: string, phase: StoredReceipt["phase"]): void;
	find(sessionId: string, key: string): StoredReceipt | undefined;
	forget(sessionId: string, key: string): void;
}

export interface StoredReceipt {
	fingerprint: string;
	messageId: string;
	queued: string;
	phase: "preparing" | "accepted" | "uncertain";
	updatedAt: number;
}

const SEND_RECEIPT_LIMIT = 128;

/** Why a send still being prepared ran out of the sender's timeout. */
export const preparationExpired = (receipt: Pick<SendReceipt, "waitingForUser">): string =>
	receipt.waitingForUser
		? "The session's user did not answer the permission dialog within the sender's timeout; nothing was sent"
		: "Message preparation timed out; nothing was sent";

/**
 * The receipts of one session's sends, keyed by the client's idempotency `key`, and the callers waiting for a run to
 * settle. It decides nothing about the message itself; `OctocodeApi.send` drives the transitions.
 */
export class SendReceipts {
	private sessionId: string | undefined;
	private readonly byKey = new Map<string, SendReceipt>();
	private readonly preparing = new Set<SendReceipt>();
	private readonly waiters = new Set<Waiter>();
	/** A settlement or session replacement invalidates late host-promise rejections, including unkeyed sends. */
	private completedVersion = 0;
	private readonly store: ReceiptStore | undefined;
	/** The key of the receipt that owns the run in progress. */
	activeKey: string | undefined;

	constructor(store?: ReceiptStore) {
		this.store = store;
	}

	/** What an earlier process recorded for `key` in this session, when no receipt of this process holds it. */
	persisted(key: string): StoredReceipt | undefined {
		return this.sessionId === undefined ? undefined : this.store?.find(this.sessionId, key);
	}

	private forgetStored(receipt: SendReceipt): void {
		if (receipt.durable) this.store?.forget(receipt.durable.sessionId, receipt.durable.key);
	}

	get settlementVersion(): number {
		return this.completedVersion;
	}

	get(key: string): SendReceipt | undefined {
		return this.byKey.get(key);
	}

	/** The receipt that owns the run in progress, when it has a key. */
	active(): SendReceipt | undefined {
		return this.activeKey === undefined ? undefined : this.byKey.get(this.activeKey);
	}

	/** A send is being prepared or owns the run: a new one would queue behind it. */
	get busy(): boolean {
		return this.activeKey !== undefined || this.preparing.size > 0;
	}

	get preparingCount(): number {
		return this.preparing.size;
	}

	/** Refuses a keyed send when every slot holds a dispatched or active receipt; cancelled (never-sent) slots yield oldest first. */
	assertRoom(key: string | undefined): void {
		if (!key || this.byKey.has(key) || this.byKey.size < SEND_RECEIPT_LIMIT) return;
		for (const [existingKey, existing] of this.byKey) {
			if (existing.phase === "cancelled") {
				this.byKey.delete(existingKey);
				if (this.byKey.size < SEND_RECEIPT_LIMIT) return;
			}
		}
		throw new RpcError(
			ERR.unavailable,
			"This session has reached its message key capacity; existing receipts are retained",
			{ execution: "not-sent" },
		);
	}

	/** Follows the session: a different one than before drops everything of the old one. */
	follow(sessionId: string): void {
		if (this.sessionId === sessionId) return;
		this.clear("The session was replaced");
		this.sessionId = sessionId;
	}

	/** The session ended: nobody may keep waiting, and nothing is kept. */
	end(): void {
		this.clear("The session ended");
		this.sessionId = undefined;
	}

	private clear(reason: string): void {
		this.completedVersion++;
		for (const waiter of this.waiters) waiter.reject(new RpcError(ERR.unavailable, reason, { execution: "accepted" }));
		this.waiters.clear();
		for (const receipt of this.preparing) this.cancelPreparation(receipt, reason);
		this.preparing.clear();
		this.byKey.clear();
		this.activeKey = undefined;
	}

	/** Starts a receipt in `preparing`; with a `key` it is kept for retries, and owns the run when the session was idle (`accept` settles it again). */
	open(
		fingerprint: string,
		accepted: SendReceipt["accepted"],
		key: string | undefined,
		busy: boolean,
		owner?: string,
	): { receipt: SendReceipt; waiter: Waiter } {
		let waiter!: Waiter;
		const settlement = new Promise<RunResult>((resolve, reject) => {
			waiter = { resolve, reject };
		});
		settlement.catch(() => undefined);
		let resolveReady!: () => void;
		let rejectReady!: (error: Error) => void;
		const ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		ready.catch(() => undefined);
		const reject = (error: Error): void => {
			waiter.reject(error);
			rejectReady(error);
		};
		const receipt: SendReceipt = {
			phase: "preparing",
			controller: new AbortController(),
			ready,
			reject,
			fingerprint,
			...(owner === undefined ? {} : { owner }),
			accepted,
			settlement,
			resolveReady,
		};
		this.preparing.add(receipt);
		if (key) {
			if (this.store && this.sessionId !== undefined) {
				receipt.durable = { sessionId: this.sessionId, key };
				this.store.save(this.sessionId, key, {
					fingerprint,
					messageId: accepted.id,
					queued: accepted.queued,
					phase: "preparing",
				});
			}
			this.byKey.set(key, receipt);
			if (!busy) this.activeKey = key;
		}
		return { receipt, waiter };
	}

	/** A send with no key that now waits for the user: its id becomes its key, so its sender can ask for the outcome. Only such a send takes a slot. */
	adopt(receipt: SendReceipt, key: string): void {
		this.byKey.set(key, receipt);
	}

	/**
	 * The message is going out: the receipt leaves `preparing`. A keyed send (or one that waits) keeps its waiter for the
	 * run's end; otherwise nobody waits. `queued` is how the session takes it now (`"turn"` when it is idle), which may
	 * differ from what was promised when the send opened: a run can have ended or begun while it was prepared. A keyed
	 * send that starts the turn owns the run.
	 */
	accept(receipt: SendReceipt, waiter: Waiter, keep: boolean, queued: string, key?: string): void {
		this.preparing.delete(receipt);
		receipt.phase = "accepted";
		receipt.accepted.queued = queued;
		if (key && queued === "turn" && this.activeKey === undefined) this.activeKey = key;
		if (receipt.durable)
			this.store?.save(receipt.durable.sessionId, receipt.durable.key, {
				fingerprint: receipt.fingerprint,
				messageId: receipt.accepted.id,
				queued: receipt.accepted.queued,
				phase: "accepted",
			});
		if (keep) this.waiters.add(waiter);
		else waiter.resolve({ text: "" });
	}

	/**
	 * The send failed. After dispatch the receipt stays (`uncertain`, so a retry with its key sees the outcome); so does one
	 * the session refused (`refused`: the same key repeats that refusal, and only a new key asks again). Otherwise nothing
	 * was sent and the key is free again.
	 */
	fail(
		receipt: SendReceipt,
		waiter: Waiter,
		key: string | undefined,
		failure: Error,
		outcome: "dispatched" | "refused" | "not-sent",
	): void {
		this.preparing.delete(receipt);
		this.waiters.delete(waiter);
		receipt.reject(failure);
		if (outcome === "dispatched") {
			receipt.phase = "uncertain";
			receipt.failure = failure;
			if (receipt.durable) this.store?.setPhase(receipt.durable.sessionId, receipt.durable.key, "uncertain");
			// This receipt cannot own turn.abort now, and a rejected handoff may never emit agent_settled.
			// The session's actual idle/pending state still controls whether a new send may start.
		} else {
			this.forgetStored(receipt);
			if (outcome === "refused") receipt.phase = "cancelled";
			else if (key) this.byKey.delete(key);
		}
		if (this.activeKey === key) this.activeKey = undefined;
	}

	/** A caller without a key stops waiting once it has its answer. */
	release(waiter: Waiter): void {
		this.waiters.delete(waiter);
	}

	/** Cancels a send still being prepared (nothing was sent); other phases are left alone. */
	cancelPreparation(receipt: SendReceipt, message: string): void {
		if (receipt.phase !== "preparing") return;
		receipt.phase = "cancelled";
		this.forgetStored(receipt);
		receipt.controller.abort();
		receipt.reject(new RpcError(ERR.unavailable, message, { execution: "not-sent" }));
		if (this.active() === receipt) this.activeKey = undefined;
		this.preparing.delete(receipt);
	}

	/**
	 * `turn.abort` with a `key`: only the receipt that owns the run may abort it, and only the caller that sent it (`owner`);
	 * another caller's key stops nothing and cancels nothing. A send still being prepared is cancelled
	 * instead (`'cancelled'`: no run was started); an accepted one owns the run (`'owner'`).
	 */
	abort(key: string, owner?: string): "cancelled" | "owner" {
		const receipt = this.byKey.get(key);
		if (this.activeKey !== key || !receipt)
			throw new RpcError(ERR.unavailable, "This request does not own the active run");
		if (receipt.owner !== undefined && receipt.owner !== owner)
			throw new RpcError(ERR.unavailable, "This request does not own the active run");
		if (receipt.phase === "preparing") {
			this.cancelPreparation(receipt, "Message preparation was cancelled; nothing was sent");
			return "cancelled";
		}
		if (receipt.phase !== "accepted") throw new RpcError(ERR.unavailable, "This request no longer owns the active run");
		return "owner";
	}

	/**
	 * Octocode settled: accepted receipts are settled and every waiter gets the result. A send still being prepared is
	 * kept, as if the run had ended a moment earlier: it goes out as a new turn at `accept`.
	 */
	settle(result: RunResult): void {
		this.completedVersion++;
		for (const receipt of this.byKey.values()) if (receipt.phase === "accepted") receipt.phase = "settled";
		if (this.active()?.phase !== "preparing") this.activeKey = undefined;
		for (const waiter of Array.from(this.waiters)) {
			this.waiters.delete(waiter);
			waiter.resolve(result);
		}
	}

	/** The run's result once it settles. Past `timeout`: a send still being prepared is cancelled and refused, a delivered one times out (`ERR.timeout`: the message was delivered). */
	async wait(receipt: SendReceipt, timeout: number): Promise<RunResult> {
		let timer: NodeJS.Timeout | undefined;
		const expired = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				if (receipt.phase === "preparing") {
					const message = preparationExpired(receipt);
					this.cancelPreparation(receipt, message);
					reject(new RpcError(ERR.unavailable, message, { execution: "not-sent" }));
				} else
					reject(
						new RpcError(ERR.timeout, "Timed out waiting for the agent to finish; the message was delivered", {
							...receipt.accepted,
							execution: "accepted",
						}),
					);
			}, timeout);
			timer.unref();
		});
		try {
			return await Promise.race([receipt.settlement, expired]);
		} finally {
			clearTimeout(timer);
		}
	}
}
