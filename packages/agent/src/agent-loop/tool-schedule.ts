import type { AgentTool, ToolConcurrency } from "../types.ts";

/**
 * A call's batch concurrency. `concurrency` decides when set (a resolver that throws makes the call exclusive, the
 * ordering that cannot race); else `executionMode: "sequential"` is exclusive and anything else shared.
 */
export function resolveToolConcurrency(tool: AgentTool<any> | undefined, args: unknown): ToolConcurrency {
	const mode = tool?.concurrency;
	if (mode === undefined) return tool?.executionMode === "sequential" ? "exclusive" : "shared";
	if (typeof mode !== "function") return mode;
	try {
		return mode(args as Record<string, unknown>);
	} catch {
		return "exclusive";
	}
}

/**
 * Orders the calls of one assistant message as they are added, in call order: a shared call starts once the last
 * exclusive call before it ended; an exclusive call starts once every earlier call ended, and every later call waits for
 * it. A failed call releases the calls behind it like a finished one.
 */
export class ToolSchedule {
	private lastExclusive: Promise<void> = Promise.resolve();
	private sharedSinceExclusive: Promise<void>[] = [];

	/** Schedule `run`; the returned promise settles with it. */
	add<T>(concurrency: ToolConcurrency, run: () => Promise<T>): Promise<T> {
		const start =
			concurrency === "exclusive"
				? Promise.all([this.lastExclusive, ...this.sharedSinceExclusive])
				: this.lastExclusive;
		const task = start.then(run);
		const settled = task.then(
			() => undefined,
			() => undefined,
		);
		if (concurrency === "exclusive") {
			this.lastExclusive = settled;
			this.sharedSinceExclusive = [];
		} else {
			this.sharedSinceExclusive.push(settled);
		}
		return task;
	}
}
