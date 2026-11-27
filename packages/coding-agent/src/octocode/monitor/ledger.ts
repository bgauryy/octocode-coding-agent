import { ATTENTION_RULES, type AttentionRuleId } from "./attention/rules.ts";

/** One rule's reading: what it last told and the value that tripped it, in the rule's unit. */
export interface Attention {
	rule: AttentionRuleId;
	value: number;
	threshold: number;
	/** What it is about: a child, a job, a list of items. */
	subject?: string;
	/** When it tripped (epoch ms); the time of recording when absent. */
	at?: number;
}

export interface RuleState {
	rule: AttentionRuleId;
	/** `tripped` from a recorded alert or an active machine threshold until the owner clears it. */
	state: "ok" | "tripped";
	/** Times the rule went from ok to tripped, plus each recorded alert while tripped. */
	trips: number;
	/** Alerts that reached the session. */
	alerts: number;
	lastValue?: number;
	threshold?: number;
	lastAlertAt?: number;
	subject?: string;
}

export type AlertListener = (alert: Attention & { delivered: boolean }) => void;

/**
 * What the monitor told this session, per rule: `attend` and the machine alert path record each alert, the machine rules
 * report their active set, and readers (a hook, a view) subscribe to each alert as it is recorded.
 */
export class MonitorLedger {
	readonly #states = new Map<AttentionRuleId, RuleState>(
		ATTENTION_RULES.map(({ id }) => [id, { rule: id, state: "ok", trips: 0, alerts: 0 }]),
	);
	readonly #listeners = new Set<AlertListener>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Every rule, in `ATTENTION_RULES` order. */
	rules(): readonly RuleState[] {
		return [...this.#states.values()].map((state) => ({ ...state }));
	}

	/** One alert of `attention.rule`; `delivered`: it reached the session (a stale session or a refused send did not). */
	record(attention: Attention, delivered: boolean): void {
		const state = this.#states.get(attention.rule);
		if (!state) throw new Error(`No monitor rule ${JSON.stringify(attention.rule)}.`);
		state.state = "tripped";
		state.trips += 1;
		state.lastValue = attention.value;
		state.threshold = attention.threshold;
		state.subject = attention.subject;
		if (delivered) {
			state.alerts += 1;
			state.lastAlertAt = attention.at ?? this.#now();
		}
		for (const listener of this.#listeners) listener({ ...attention, delivered });
	}

	/** Whether `rule` is over its threshold now: a cleared threshold reads ok; a new trip counts once. */
	trip(rule: AttentionRuleId, active: boolean): void {
		const state = this.#states.get(rule);
		if (!state) throw new Error(`No monitor rule ${JSON.stringify(rule)}.`);
		if (active && state.state === "ok") state.trips += 1;
		state.state = active ? "tripped" : "ok";
	}

	/** Calls `listener` with each alert recorded from now on; returns what stops it. */
	subscribe(listener: AlertListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}

const ledgers = new WeakMap<object, MonitorLedger>();

/** The session's ledger, keyed by its feature API; created on first use. */
export function monitorLedgerOf(api: object): MonitorLedger {
	let ledger = ledgers.get(api);
	if (!ledger) {
		ledger = new MonitorLedger();
		ledgers.set(api, ledger);
	}
	return ledger;
}
