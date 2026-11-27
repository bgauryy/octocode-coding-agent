import { setImmediate as yieldToIO } from "node:timers/promises";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Batch } from "../events/loop/types.ts";
import type { Held, Message, SendOptions } from "./gate-types.ts";

const SENDS_PER_TICK = 32;
const SYNCHRONOUS_SENDS = 4;
const SEND_BUDGET_MS = 8;

const isPromise = (value: unknown): value is Promise<void> =>
	typeof (value as { then?: unknown } | undefined)?.then === "function";

/** What the host of the loop answers while a batch goes out (`live-host.ts`). */
export interface RoutedHost {
	sending(seq: number, held: Held): void;
	assertOwner(): void;
	mayWake(): boolean;
	ending(): boolean;
}

/** What the gate lends to a batch's send. */
export interface RoutedGate {
	send(message: Message, options: SendOptions): void | Promise<void>;
	release(held: Held): void;
	track(labels: string[], sending: void | Promise<void>): void;
	publish(): void;
}

/** Hands one batch to the transcript, yielding between slices. A model turn can outlive the handoff. */
export function sendRouted(batch: Batch<Held>, host: RoutedHost, gate: RoutedGate): void | Promise<void> {
	const entries = batch.entries;
	// The session starts typed input itself. buildBatch puts it first.
	const wake = batch.trigger && entries[0]?.type !== "input";
	let label: string | undefined;
	let index = 0;
	let reported = false;
	const failed = (each: Held, error: unknown) => {
		if (host.ending() && !reported) {
			reported = true;
			process.stderr.write(`octocode: a held wake message was not sent at session end: ${errorMessage(error)}\n`);
		}
		each.done.reject(error);
	};
	const slice = (): boolean => {
		const limit = Math.min(index + SENDS_PER_TICK, entries.length);
		const deadline = entries.length <= SYNCHRONOUS_SENDS ? undefined : performance.now() + SEND_BUDGET_MS;
		while (index < limit) {
			const entry = entries[index++];
			if (entry.type !== "event") continue;
			const each = entry.carry;
			host.assertOwner();
			gate.release(each);
			host.sending(entry.seq, each);
			label ??= each.labels[0];
			const triggerTurn = wake && index === entries.length && host.mayWake();
			try {
				const result = gate.send(each.message, { ...each.options, deliverAs: "steer", triggerTurn });
				if (triggerTurn && label !== undefined) gate.track([label], result);
				if (isPromise(result)) result.then(each.done.resolve, (error: unknown) => failed(each, error));
				else each.done.resolve();
			} catch (error) {
				failed(each, error);
			}
			if (deadline !== undefined && performance.now() >= deadline) break;
		}
		gate.publish();
		return index === entries.length;
	};
	if (slice()) return;
	const remaining = async () => {
		do {
			await yieldToIO();
		} while (!slice());
	};
	return remaining();
}
