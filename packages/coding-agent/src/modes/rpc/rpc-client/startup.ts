const MAX_TIMER_MS = 2_147_483_647;

/** Validate before spawning: Node clamps out-of-range delays to one millisecond. */
export function startupTimeout(value = 60_000): number {
	const timeout = value;
	if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMER_MS) {
		throw new RangeError(`startupTimeoutMs must be an integer between 1 and ${MAX_TIMER_MS}`);
	}
	return timeout;
}
