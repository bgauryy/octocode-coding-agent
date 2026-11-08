import { sessionApiTurnCeiling } from "../enabled.ts";
import type { ApiOperations, TurnCeiling } from "./contracts.ts";

/**
 * The one owner of the `sessionApiTurnPermission` ceiling for the API bridge. Every method that starts or steers work on
 * the session's behalf takes it from here:
 * - `message.send` (`send.ts`) reads the same setting (`sessionApiTurnCeiling`) for admission and the turn's cap, and sets and releases the cap through `operations`;
 * - `external.call` runs inside `hold()`, so the spawn check and the external agent's permission requests are judged under it;
 * - `agents.tell` (`tell.ts`) is admitted under `current()`; when it reaches a member this process runs (named, or through
 *   "all"), it sets the cap through `operations` until `agent_settled`, while a recipient in another process runs under
 *   that process's own mode.
 *
 * The cap is one process-wide setting, so `operations` (hand it to everything that calls `capTurn`) keeps a call's cap in
 * place when a send-started turn settles, and a finished call leaves a send-started turn's cap alone.
 */
export class TurnCeilings {
	#calls = 0;
	/** A turn `message.send` started holds the cap until the session settles. */
	#sendHolds = false;
	readonly #base: ApiOperations;
	/** The operations to use in place of the ones given: `capTurn` goes through this owner. */
	readonly operations: ApiOperations;

	constructor(base: ApiOperations) {
		this.#base = base;
		this.operations = {
			...base,
			capTurn: (ceiling) => {
				this.#sendHolds = ceiling !== undefined;
				if (ceiling === undefined && this.#calls > 0) return;
				base.capTurn?.(ceiling);
			},
		};
	}

	/** The ceiling the user set, read for each call: `undefined` unless `sessionApiTurnPermission` is explicitly `workspace`. */
	current(): TurnCeiling | undefined {
		return sessionApiTurnCeiling();
	}

	/** Runs `run` with the session's tool calls and asks held to the ceiling (when one is set), and releases it after. */
	async hold<T>(run: () => Promise<T>): Promise<T> {
		const ceiling = this.current();
		if (!ceiling) return run();
		this.#calls++;
		this.#base.capTurn?.(ceiling);
		try {
			return await run();
		} finally {
			if (--this.#calls === 0 && !this.#sendHolds) this.#base.capTurn?.(undefined);
		}
	}
}
