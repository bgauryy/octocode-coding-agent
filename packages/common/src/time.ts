export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const pad = (value: number) => String(value).padStart(2, "0");

/** A reset as a reader plans by it: `14:20` within a day, `Fri 09:00` within a week, else `Dec 1`. Local time. */
export function resetClock(at: number, now: number): string {
	const date = new Date(at);
	const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	if (at - now < DAY_MS) return clock;
	if (at - now < 7 * DAY_MS) return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${clock}`;
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
