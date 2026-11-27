import type { EventFilter } from "./on.ts";

/** The call fields models send for the same thing as a declared field: accepted by validation, mapped here. */
export interface NotifyAliases {
	delay?: number;
	seconds?: number;
	interval?: number;
}

/** The fields of a call the normalization reads and may rewrite. */
interface NotifyShape extends NotifyAliases {
	op: "set" | "on" | "off" | "list";
	event?: string;
	filter?: EventFilter & { job?: string; name?: string };
	check?: string;
	after?: number;
	every?: number;
	cron?: string;
}

export type Normalized<T extends NotifyShape> =
	| { kind: "call"; params: Omit<T, keyof NotifyAliases> }
	| { kind: "implicit"; job: string };

/**
 * The call a model meant, where one reading is unambiguous: `delay`/`seconds` for `after`, `interval` for `every`,
 * `filter.name` for `filter.agent`, `set` carrying an event is `on`, `on` carrying only a time is `set`, an `on` with no
 * event whose filter names one (`command`, `agent`, `ref` with `state`) takes that event, and `agent.ended` with no
 * agent takes the only running child. A `filter.job` is a job whose end already notifies: nothing is set.
 * `running` are the names of the running children.
 */
export function normalizeNotify<T extends NotifyShape>(params: T, running: readonly string[]): Normalized<T> {
	const { delay, seconds, interval, ...rest } = params;
	const next: NotifyShape = { ...rest };
	const after = next.after ?? delay ?? seconds;
	if (after !== undefined) next.after = after;
	if (next.every === undefined && interval !== undefined) next.every = interval;
	const { job, name, ...filter } = next.filter ?? {};
	if (job !== undefined && job.trim() !== "") return { kind: "implicit", job };
	if (next.filter)
		next.filter = { ...filter, ...(name !== undefined && filter.agent === undefined ? { agent: name } : {}) };
	const hasFilter = Object.values(next.filter ?? {}).some((value) => value !== undefined);
	const timed = next.after !== undefined || next.every !== undefined;
	// With a time beside the event the reading is ambiguous (`after` delays an `on`'s first check): the refusal stands.
	if (next.op === "set" && next.event !== undefined && next.event !== "time.due" && !timed) next.op = "on";
	if (
		next.op === "on" &&
		(next.event === "time.due" || (next.event === undefined && timed && !hasFilter && next.check === undefined))
	) {
		if (timed) {
			next.op = "set";
			delete next.event;
		}
	}
	if (next.op === "on" && next.event === undefined) {
		const f = next.filter ?? {};
		if (f.command !== undefined) next.event = "check.result";
		else if (f.agent !== undefined && f.ref === undefined && f.path === undefined) next.event = "agent.ended";
		else if (f.ref !== undefined && f.state !== undefined) next.event = "item.state";
	}
	if (next.op === "on" && next.event === "agent.ended" && (next.filter?.agent ?? "").trim() === "") {
		if (running.length === 1) next.filter = { ...next.filter, agent: running[0] };
		else
			throw new Error(
				`agent.ended needs filter.agent, the child's name${running.length ? ` (running: ${running.join(", ")})` : " (no child is running)"}. A running child's report already notifies you.`,
			);
	}
	return { kind: "call", params: next as unknown as Omit<T, keyof NotifyAliases> };
}
