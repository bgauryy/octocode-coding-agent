/** How long an RPC process may spend in its ordered shutdown before it exits regardless. */
const RPC_SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * Exits the process after `ms` unless the shutdown finished first. The timer is unref'd, so it never keeps a process
 * alive that would end anyway, and it fires even when the shutdown awaits something that never settles.
 */
export function armShutdownDeadline(exitCode: number, ms = RPC_SHUTDOWN_DEADLINE_MS, exit = process.exit): void {
	setTimeout(() => exit(exitCode), ms).unref();
}
