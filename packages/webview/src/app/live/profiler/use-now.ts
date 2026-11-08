import { useSyncExternalStore } from "react";

/**
 * The profiler's one clock. Every ticking timer reads `useNow()`: a single interval wakes them all once a second, and
 * it runs only while something is subscribed. The page measures the host's clock offset when it fetches and calls
 * `setClockSkew`, so a timer that counts from a host timestamp (`now - activity.since`) is right on a skewed machine.
 */
const TICK_MS = 1000;

let skew = 0;
let current = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

const read = () => Date.now() - skew;

function tick() {
	current = read();
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		current = read();
		timer = setInterval(tick, TICK_MS);
	}
	return () => {
		listeners.delete(listener);
		if (!listeners.size && timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};
}

/** `skew` = this machine's `Date.now()` minus the host's, measured when a host timestamp arrived. */
export function setClockSkew(value: number): void {
	if (value === skew) return;
	skew = value;
	if (listeners.size) tick();
	else current = read();
}

/** While nothing is subscribed no interval refreshes `current`: a read refreshes it at most once a second. */
function snapshot(): number {
	if (!listeners.size) {
		const latest = read();
		if (Math.abs(latest - current) >= TICK_MS) current = latest;
	}
	return current;
}

/** The host's current time (epoch ms), updated once a second while the component is mounted. */
export function useNow(): number {
	return useSyncExternalStore(subscribe, snapshot);
}

/** `02:14`, or `1:02:14` from an hour: an elapsed time in the form a stopwatch shows. */
export function formatClock(ms: number): string {
	const total = Math.floor(Math.max(0, ms) / 1000);
	const seconds = String(total % 60).padStart(2, "0");
	const minutes = Math.floor(total / 60) % 60;
	const hours = Math.floor(total / 3600);
	return hours
		? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
		: `${String(minutes).padStart(2, "0")}:${seconds}`;
}
