import type { RunningWork, WorkRow } from "../shared/running-work.ts";

/**
 * The one owner of work that outlasts a tool call's foreground budget. A tool hands its work to `run`: the call gets the
 * work's value when it ends within the budget, and otherwise a job while the work goes on. The job's end is reported once,
 * to the session that started it (`JobPorts.deliver`); a user or the session's end stops it. One instance per session
 * (`registry.ts`); bash keeps its process-specific `BashJobs` beside it.
 */

/** Who stopped a job; a stop is not a failure. */
export type StopReason = "user" | "session end";

/** What a tool says about the call that may become a job. */
export interface JobSpec {
	/** The tool that started it: `web`, `models`, `mcp__server__tool`. */
	tool: string;
	/** The call in a few words: the row's detail and the report's first line. */
	title: string;
	/** The call's `reason`, shown first on its row. */
	reason?: string;
	/** The backlog item (`B12`) the call serves. */
	item?: string;
	/** How long the call waits for its work before the work continues as a job (milliseconds). */
	foregroundMs: number;
	/** The call's own signal: it aborts the work while the call still waits, and no longer once the work is a job. */
	signal?: AbortSignal;
}

/** A job: work that outlived its call. */
export interface Job {
	readonly id: string;
	readonly tool: string;
	readonly title: string;
	readonly reason?: string;
	readonly item?: string;
	readonly startedAt: number;
}

/** How a job ended. */
export type JobOutcome =
	| { kind: "done"; value: unknown; durationMs: number }
	| { kind: "failed"; error: unknown; durationMs: number }
	| { kind: "stopped"; by: StopReason; durationMs: number };

/** The result of `run`: the work's value, or the job the work became. */
export type Started<T> = { status: "done"; value: T } | { status: "job"; job: Job };

/** What the session's wiring gives the jobs of one session. */
export interface JobPorts {
	/** Hands a finished job's report to the session that started it. */
	deliver(job: Job, outcome: JobOutcome): void | Promise<void>;
	/** A report that could not be delivered. */
	failed(job: Job, error: unknown): void;
	/** The footer and work rows; their cancel button stops the job. */
	work?: RunningWork;
}

interface Live extends Job {
	controller: AbortController;
	settled: boolean;
	finish(outcome: JobOutcome): void;
}

export class AsyncJobs {
	private readonly live = new Map<string, Live>();
	/** One promise per job, settled after its report was handed over. */
	private readonly pending = new Set<Promise<void>>();
	private next = 0;
	private ports: JobPorts | undefined;

	/** Connects the session: where reports go and which rows show the jobs. Replaces an earlier connection. */
	attach(ports: JobPorts): void {
		this.ports = ports;
		ports.work?.onCancel("job", (id) => this.stop(id, "user"));
		this.publish();
	}

	/** Whether reports have somewhere to go; without it `run` cannot hand work over and keeps the call waiting. */
	get attached(): boolean {
		return this.ports !== undefined;
	}

	/** The running job `id`. */
	get(id: string): Job | undefined {
		return this.live.get(id);
	}

	running(): Job[] {
		return [...this.live.values()];
	}

	/**
	 * Runs `work`. Within `spec.foregroundMs` the call gets its value (or its error, thrown); past it the work goes on as a
	 * job. `work` gets the signal that stops it: the call's while the call waits, then the job's own. Unattached, the call
	 * waits for the work: nothing could receive a report.
	 */
	async run<T>(spec: JobSpec, work: (signal: AbortSignal) => Promise<T>): Promise<Started<T>> {
		const controller = new AbortController();
		const startedAt = Date.now();
		const abortCall = () => controller.abort(spec.signal?.reason);
		if (spec.signal?.aborted) abortCall();
		else spec.signal?.addEventListener("abort", abortCall, { once: true });
		// Started in this tick, so work that checks the signal at once sees an abort that already happened.
		const outcome: Promise<JobOutcome> = (async () => work(controller.signal))().then(
			(value): JobOutcome => ({ kind: "done", value, durationMs: Date.now() - startedAt }),
			(error: unknown): JobOutcome => ({ kind: "failed", error, durationMs: Date.now() - startedAt }),
		);
		let cancelBudget: () => void = () => undefined;
		let early: JobOutcome | undefined;
		try {
			early = await (this.ports
				? Promise.race([
						outcome,
						new Promise<undefined>((resolve) => {
							const timer = setTimeout(resolve, Math.max(0, spec.foregroundMs));
							cancelBudget = () => clearTimeout(timer);
						}),
					])
				: outcome);
			// The call's abort and the budget can end in the same tick: that is the call's end, not a job.
			if (!early && spec.signal?.aborted) early = await outcome;
		} finally {
			cancelBudget();
			if (early) spec.signal?.removeEventListener("abort", abortCall);
		}
		if (early) {
			if (early.kind === "failed") throw early.error;
			return { status: "done", value: (early as { value: T }).value };
		}
		spec.signal?.removeEventListener("abort", abortCall);
		return { status: "job", job: this.adopt(spec, controller, startedAt, outcome) };
	}

	private adopt(spec: JobSpec, controller: AbortController, startedAt: number, outcome: Promise<JobOutcome>): Live {
		let reported: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			reported = resolve;
		});
		this.pending.add(done);
		const job: Live = {
			id: `task-${++this.next}`,
			tool: spec.tool,
			title: spec.title,
			...(spec.reason ? { reason: spec.reason } : {}),
			...(spec.item ? { item: spec.item } : {}),
			startedAt,
			controller,
			settled: false,
			finish: (ended) => {
				if (job.settled) return;
				job.settled = true;
				this.live.delete(job.id);
				this.publish();
				void this.report(job, ended).finally(() => {
					this.pending.delete(done);
					reported();
				});
			},
		};
		this.live.set(job.id, job);
		this.publish();
		void outcome.then((ended) => job.finish(ended));
		return job;
	}

	private async report(job: Live, ended: JobOutcome): Promise<void> {
		try {
			await this.ports?.deliver(job, ended);
		} catch (error) {
			this.ports?.failed(job, error);
		}
	}

	/** Stops the job `id`: its work is aborted and the job ends at once as stopped. False when no such job runs. */
	stop(id: string, by: StopReason): boolean {
		const job = this.live.get(id);
		if (!job) return false;
		job.controller.abort(new Error(`job ${id} stopped (${by})`));
		job.finish({ kind: "stopped", by, durationMs: Date.now() - job.startedAt });
		return true;
	}

	/** Stops every job and resolves once each report was handed over. */
	async stopAll(by: StopReason): Promise<void> {
		for (const job of this.running()) this.stop(job.id, by);
		await this.settle();
	}

	/** Resolves when no job runs and every report was handed over. */
	async settle(): Promise<void> {
		while (this.pending.size > 0) await Promise.all(this.pending);
	}

	private publish(): void {
		this.ports?.work?.set(
			"job",
			[...this.live.values()].map((job): WorkRow => ({
				kind: "job",
				id: job.id,
				title: job.reason?.trim() || job.title,
				detail: job.reason?.trim() ? `${job.tool} ${job.title}` : job.tool,
				startedAt: job.startedAt,
				...(job.item ? { item: job.item } : {}),
			})),
		);
	}
}
