import type { UiState } from "../../../../theme/status.ts";
import { clip } from "../../../shared/text.ts";
import { describeCondition, parseUntil } from "../../../timer/conditions/index.ts";
import { type EventFilter, untilOfEvent } from "../../../timer/on.ts";

/** The call's arguments as the row sees them: model output, possibly malformed while the call renders. */
interface CallArgs {
	op?: unknown;
	id?: unknown;
	all?: unknown;
	after?: unknown;
	every?: unknown;
	cron?: unknown;
	event?: unknown;
	filter?: unknown;
	note?: unknown;
	items?: unknown;
}

/** A malformed argument as it reads: a scalar as itself, anything else as its JSON, clipped. */
const shown = (value: unknown): string =>
	typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? clip(String(value), 40)
		: clip(JSON.stringify(value) ?? "", 40);

const cronText = (value: unknown): string => (typeof value === "string" ? clip(value, 40) : "");

/** The call's event, in a few words. */
function eventTarget(args: CallArgs): string {
	if (args.event === undefined) return "";
	try {
		const condition = parseUntil(untilOfEvent(args.event, args.filter as EventFilter | undefined, undefined));
		return condition ? clip(describeCondition(condition), 80) : "";
	} catch {
		// Not a valid event (yet): show only the name it was given.
		return typeof args.event === "string" ? clip(args.event, 40) : "";
	}
}

/** When the notice is due: a time, a cron schedule, or an event with its filter. */
function condition(args: CallArgs): string {
	if (args.cron !== undefined) return `cron ${cronText(args.cron)}`;
	if (args.every !== undefined) return `every ${shown(args.every)}s`;
	if (args.after !== undefined) return `in ${shown(args.after)}s`;
	return eventTarget(args);
}

const isOff = (args: CallArgs) => args.op === "off";
const isList = (args: CallArgs) => args.op === "list";

/** The row's title: a request reads "Notify me when", off and list name what they do. */
export function notifyTitle(args: CallArgs): string {
	if (isOff(args)) return "Notify off";
	if (isList(args)) return "Notify list";
	return "Notify me when";
}

/** What follows the title: the condition of a request, the id or `all` of an off, `all` of a list. */
export function notifySummary(args: CallArgs): string {
	if (isOff(args)) return args.all === true ? "all" : args.id === undefined ? "" : shown(args.id);
	if (isList(args)) return args.all === true ? "all" : "";
	if (Array.isArray(args.items)) return `${args.items.length} requests`;
	return condition(args);
}

/** The note the notice will carry, quoted; empty without one. */
export function notifyNote(args: CallArgs, max: number): string {
	return typeof args.note === "string" && args.note !== "" ? `"${clip(args.note, max)}"` : "";
}

/**
 * A request that was accepted waits for its time or event, needing nothing from the user: it stays `pending` until the
 * notice arrives. Off and list are plain calls; a failed call keeps its own state.
 */
export function notifyState(args: CallArgs, failed: boolean): UiState | undefined {
	return isOff(args) || isList(args) || failed ? undefined : "pending";
}
