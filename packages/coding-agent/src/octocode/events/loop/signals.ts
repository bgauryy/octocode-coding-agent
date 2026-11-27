import type { LoopInput } from "./state.ts";

/**
 * What the host tells the loop about the session: the run, its steps, compaction and the end (`wake/session-signals.ts`
 * binds them to the bus).
 */
export interface SessionSignals {
	/** A run segment started. */
	runStarted(): void;
	/** A step of the run ended; `final` is a reply with no tool calls, where the run would stop. */
	stepEnded(final: boolean): void | Promise<void>;
	/** A turn began. */
	turnStarted(): void | Promise<void>;
	/**
	 * The run settled; `continues` is whether the session holds a message it runs next, `aborted` whether the run was
	 * stopped rather than finished.
	 */
	settled(continues: boolean, aborted?: boolean): void | Promise<void>;
	/** Compaction took the lock. */
	compactionStarted(): void;
	/** Compaction ended, failed or was cancelled. */
	compactionEnded(stopped?: boolean): void | Promise<void>;
	/** The session ends. */
	end(): unknown;
}

/** The part of `EventLoop` these rules drive. */
interface Dispatcher {
	stepBoundary(): void;
	continueRun(): boolean;
	settle(): boolean;
	signal(input: LoopInput): unknown;
}

/**
 * The step and settle rules. A step that ended with a final reply is where the run would stop: if the
 * session starts another turn anyway, it took a message it held, and that is where the loop hands over what it holds.
 */
export class RunSignals {
	private stopPoint = false;
	private readonly loop: Dispatcher;

	constructor(loop: Dispatcher) {
		this.loop = loop;
	}

	stepEnded(final: boolean): void {
		this.loop.stepBoundary();
		this.stopPoint = final;
	}

	turnStarted(): void {
		if (!this.stopPoint) return;
		this.stopPoint = false;
		this.loop.continueRun();
	}

	/** Returns whether the loop delivered something that continues the run. The session is the authority on whether it runs: the loop follows it. */
	settled(continues: boolean): boolean {
		this.stopPoint = false;
		const wouldContinue = this.loop.settle();
		if (!continues) this.loop.signal("run_end");
		return wouldContinue;
	}
}
