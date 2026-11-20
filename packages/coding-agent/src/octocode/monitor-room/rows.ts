import type { RuleState } from "../monitor/ledger.ts";
import { formatAgo } from "../shared/format.ts";
import { columnRows } from "../../theme/columns.ts";

/**
 * The unit a rule reports in. A rule without an entry shows bare numbers, so a rule added to the monitor appears in the
 * room at once and only lacks its unit.
 */
const UNITS: Readonly<Record<string, string>> = {
	memory: "%",
	swap: "%",
	gpu: "%",
	job: "m",
	context: "%",
	"check-in": "s",
	"idle-agent": "m",
	"stalled-item": "m",
};

/** One monitor rule as the room shows it. */
export interface RoomRow {
	rule: string;
	state: "ok" | "tripped";
	/** The last reading against its threshold (`91% vs 90%`), or `-` before the rule first tripped. */
	reading: string;
	trips: number;
	alerts: number;
	/** `3m ago`, or `-` when no alert reached the session. */
	lastAlert: string;
	subject: string;
}

const NONE = "-";

/** One row per rule of `rules`, in their order. */
export function roomRows(rules: readonly RuleState[], now: number): RoomRow[] {
	return rules.map((state) => {
		const unit = UNITS[state.rule] ?? "";
		return {
			rule: state.rule,
			state: state.state,
			reading:
				state.lastValue === undefined
					? NONE
					: `${state.lastValue}${unit} vs ${state.threshold ?? NONE}${state.threshold === undefined ? "" : unit}`,
			trips: state.trips,
			alerts: state.alerts,
			lastAlert: state.lastAlertAt === undefined ? NONE : formatAgo(now - state.lastAlertAt),
			subject: state.subject ?? NONE,
		};
	});
}

const HEADER = ["rule", "state", "reading", "trips", "alerts", "last alert", "subject"] as const;

/** The rows as an aligned text table, for a session without a screen. */
export function roomText(rows: readonly RoomRow[]): string {
	const cells = rows.map((row) => [
		row.rule,
		row.state,
		row.reading,
		String(row.trips),
		String(row.alerts),
		row.lastAlert,
		row.subject,
	]);
	return columnRows([HEADER, ...cells]).join("\n");
}

/** The page row's muted text: everything but the rule and the state, which the row and its badge carry. */
export function roomDetail(row: RoomRow): string {
	const parts = [row.reading, `trips ${row.trips}`, `alerts ${row.alerts}`];
	if (row.lastAlert !== NONE) parts.push(`last ${row.lastAlert}`);
	if (row.subject !== NONE) parts.push(row.subject);
	return parts.join(" · ");
}
