import { descendantRows } from "../../shared/process-descendants.ts";
import type { ProcessRow } from "../../shared/process-table.ts";
import { stopTree } from "../../shared/process.ts";
import { settleWithin } from "../../shared/util.ts";
import { ABORT_SETTLE_MS } from "./outcome.ts";

interface ShutdownOptions {
	pid: number | undefined;
	abort(): boolean;
	closeInput(): void;
	settled(): boolean;
	settledEvent: Promise<void>;
	exitEvent: Promise<void>;
}

/** Stops work immediately with a held abort, then captures ownership before EOF lets the native child exit. */
export class ChildShutdown {
	private snapshot: Promise<ProcessRow[]> | undefined;
	private readonly options: ShutdownOptions;
	constructor(options: ShutdownOptions) {
		this.options = options;
	}

	private capture(): Promise<ProcessRow[]> {
		return (this.snapshot ??= descendantRows(this.options.pid));
	}

	async closeInput(): Promise<void> {
		await this.capture();
		this.options.closeInput();
	}

	async hasDescendants(): Promise<boolean> {
		return this.snapshot !== undefined && (await this.snapshot).length > 0;
	}

	async stopTree(graceMs: number): Promise<void> {
		await stopTree(this.options.pid, graceMs, await this.capture());
	}

	async stop(graceMs: number): Promise<void> {
		if (this.options.abort()) await settleWithin(this.options.settledEvent, ABORT_SETTLE_MS);
		await this.closeInput();
		if (this.options.settled()) await settleWithin(this.options.exitEvent, graceMs);
		await this.stopTree(graceMs);
	}
}
