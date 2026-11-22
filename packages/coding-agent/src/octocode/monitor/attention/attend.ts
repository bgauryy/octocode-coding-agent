import { MONITOR_SOURCE } from "../../events/source.ts";
import { isStaleSessionError } from "../../shared/util.ts";
import { wakeGateOf } from "../../wake/gate.ts";
import { type Attention, monitorLedgerOf } from "../ledger.ts";

export type { Attention };

/** `wake` starts a turn through the wake gate; `note` joins the next request without starting one. */
export type Delivery = { how: "wake"; deliverAs?: "followUp" | "steer" } | { how: "note"; deliverAs?: "steer" };

/** Sends nothing to the model: the alert is recorded in the ledger (its hook and room), and the caller shows it to the user. */
export type LedgerDelivery = { how: "ledger" };

export interface AttentionMessage {
	customType: string;
	content: string;
	details?: unknown;
	/** Shown in the transcript; hidden by default. */
	display?: boolean;
}

type AttendApi = Parameters<typeof wakeGateOf>[0];

/**
 * The one way a monitor rule tells its session. A wake is listed as `monitor.alert` on the woken turn's row; a note never
 * starts a turn. The caller's `customType` and `details` are sent as given, so a rule can read its own messages back. The
 * ledger records each alert once the send settles. Resolves whether the session took it: false for a session that ended;
 * any other failure throws (synchronously, or as the rejection). A ledger-only alert has no message and counts as
 * delivered: its recipients are the ledger's readers (the MonitorAlert hook, the monitor room) and the user.
 */
export function attend(
	api: object,
	attention: Attention,
	message: undefined,
	delivery: LedgerDelivery,
): Promise<boolean>;
export function attend(
	api: AttendApi,
	attention: Attention,
	message: AttentionMessage,
	delivery: Delivery,
): Promise<boolean>;
export function attend(
	api: object,
	attention: Attention,
	message: AttentionMessage | undefined,
	delivery: Delivery | LedgerDelivery,
): Promise<boolean> {
	const ledger = monitorLedgerOf(api);
	const at = attention.at ?? Date.now();
	const told = { ...attention, at };
	if (delivery.how === "ledger" || message === undefined) {
		ledger.record(told, true);
		return Promise.resolve(true);
	}
	const sent = { ...message, display: message.display ?? false };
	let sending: void | Promise<void>;
	try {
		// The overloads hand a message, and so a session API, to every delivery but the ledger's.
		const gate = wakeGateOf(api as AttendApi);
		sending =
			delivery.how === "wake"
				? gate.emit(
						{
							kind: "monitor.alert",
							rule: attention.rule,
							value: attention.value,
							threshold: attention.threshold,
							at,
							...(attention.subject === undefined ? {} : { subject: attention.subject }),
						},
						sent,
						{ triggerTurn: true, ...(delivery.deliverAs ? { deliverAs: delivery.deliverAs } : {}) },
					)
				: gate.emit(
						[],
						sent,
						{ triggerTurn: false, ...(delivery.deliverAs ? { deliverAs: delivery.deliverAs } : {}) },
						false,
						[MONITOR_SOURCE],
					);
	} catch (error) {
		if (!isStaleSessionError(error)) throw error;
		ledger.record(told, false);
		return Promise.resolve(false);
	}
	return Promise.resolve(sending).then(
		() => {
			ledger.record(told, true);
			return true;
		},
		(error: unknown) => {
			ledger.record(told, false);
			if (isStaleSessionError(error)) return false;
			throw error;
		},
	);
}
