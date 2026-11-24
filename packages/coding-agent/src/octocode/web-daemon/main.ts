import path from "node:path";
import { DAEMON_PROTOCOL_VERSION, type DaemonRecord } from "@octocodeai/octocode-contracts/daemon";
import { privateDir } from "../shared/home.ts";
import { processStartTime } from "../shared/process.ts";
import { processTitle, setProcessTitle, WEB_DAEMON_ROLE } from "../shared/process-title.ts";
import { TEST_GUARD_FILE_ENV, TEST_PROTECTED_HOMES_ENV } from "../../storage/state-paths.ts";
import { RotatingLog } from "../shared/rotating-log.ts";
import { sharedClock } from "@octocodeai/octocode-common/clock";
import { redactSecrets } from "@octocodeai/octocode-common/sanitize";
import { acquireRegistryLock } from "../backlog/shared-web-lock.ts";
import type { DaemonPage } from "./build.ts";
import { createConfigRoutes } from "./config-factory.ts";
import { webDaemonIdleMinutes, webDaemonPaths } from "./paths.ts";
import { removeRecord, writeDaemonRecord } from "./records.ts";
import { startDaemonServer, type DaemonServer } from "./server.ts";

const DRAIN_LIMIT_MS = 30_000;
const LOCK_WAIT_MS = 2000;

export interface RunningDaemon {
	server: DaemonServer;
	/** Resolves after the daemon stopped listening and removed its record. */
	stopped: Promise<void>;
	shutdown(): Promise<void>;
}

/**
 * Starts the user-level daemon in this process: takes the run lock (a second daemon cannot start beside it), listens,
 * and only then writes the record. It exits after `OCTOCODE_WEB_DAEMON_IDLE_MINUTES` (default 10) with no browser tab
 * no attached session and no device connected through a relay, or when told to drain by a launcher of another build. Resolves undefined when another daemon
 * already runs.
 */
export async function startWebDaemon(
	env: NodeJS.ProcessEnv = process.env,
	options: { page?: DaemonPage } = {},
): Promise<RunningDaemon | undefined> {
	const paths = webDaemonPaths(env);
	privateDir(paths.dir);
	let release: (() => Promise<void>) | undefined;
	// Set once the lock is held; a compromise before then cannot happen (the lock is taken with no wait in between).
	let onLockLost: () => void = () => {};
	try {
		// The run lock is what keeps a second daemon out. Losing it (this process stalled past its stale limit and another
		// daemon took it) ends this one: it drops only its own record (nonce-matched) and leaves the new owner's lock alone.
		release = await acquireRegistryLock(paths.runLock, LOCK_WAIT_MS, { onCompromised: () => onLockLost() });
	} catch {
		return undefined;
	}
	const idleMinutes = webDaemonIdleMinutes(env);
	const idleLimit = idleMinutes * 60_000;
	let lastActivity = Date.now();
	let stopping: Promise<void> | undefined;
	let stopDrainTimer: (() => void) | undefined;
	let onStopped: () => void = () => {};
	const stopped = new Promise<void>((resolve) => (onStopped = resolve));
	let server: DaemonServer | undefined;
	let nonce = "";
	const { routes: configRoutes, signIns } = createConfigRoutes({ env, actor: () => `web:${nonce.slice(0, 8)}` });
	const stopIdleTimer = sharedClock.subscribe(
		() => {
			if (!server || server.draining) return;
			if (server.tabs.count > 0 || server.registry.attached > 0 || server.remote.peers > 0) lastActivity = Date.now();
			else if (Date.now() - lastActivity >= idleLimit) void shutdown();
		},
		{ everyMs: Math.min(1000, Math.max(50, idleLimit / 4)) },
	);
	const dropRecord = () => removeRecord(paths.record, (text) => text.includes(nonce));
	const shutdown = (): Promise<void> =>
		(stopping ??= (async () => {
			stopIdleTimer();
			stopDrainTimer?.();
			signIns.closeAll();
			dropRecord();
			await server?.close().catch(() => undefined);
			await release?.().catch(() => undefined);
			release = undefined;
			onStopped();
		})());
	onLockLost = () => void shutdown();
	try {
		server = await startDaemonServer({
			env,
			page: options.page,
			onActivity: () => (lastActivity = Date.now()),
			idleMinutes,
			...configRoutes,
			onDrain: () => {
				if (!server || server.draining) return;
				server.draining = true;
				// A new daemon may take over now; this one serves its open tabs until they leave or the limit passes.
				dropRecord();
				void release?.().catch(() => undefined);
				release = undefined;
				const deadline = Date.now() + DRAIN_LIMIT_MS;
				stopDrainTimer = sharedClock.subscribe(
					() => {
						if ((server?.tabs.count ?? 0) === 0 || Date.now() >= deadline) void shutdown();
					},
					{ everyMs: 500 },
				);
			},
		});
	} catch (error) {
		await release?.().catch(() => undefined);
		throw error;
	}
	nonce = server.nonce;
	const startedAt = Date.now();
	const record: DaemonRecord = {
		pid: process.pid,
		...(processStartTime(process.pid) ? { pid_started: processStartTime(process.pid) } : {}),
		port: server.port,
		url: `http://127.0.0.1:${server.port}/#access=${server.token}`,
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		build: server.build,
		startedAt,
		nonce,
	};
	try {
		writeDaemonRecord(paths.record, record);
	} catch (error) {
		await shutdown();
		throw error;
	}
	return { server, stopped, shutdown };
}

/** More uncaught errors than this inside `CRASH_WINDOW_MS` mean the process is broken, not that one peer misbehaved. */
const CRASH_LIMIT = 20;
const CRASH_WINDOW_MS = 60_000;

/**
 * What the daemon does with an uncaught error: write one redacted line to `log` and keep serving, unless more than
 * `CRASH_LIMIT` arrive within `CRASH_WINDOW_MS`, which means the process itself is broken and `stop` is called.
 */
export function crashGuard(options: {
	log?: { write(text: string): void };
	stop: () => void;
	now?: () => number;
}): (kind: string) => (error: unknown) => void {
	let recent: number[] = [];
	const clock = options.now ?? Date.now;
	return (kind) => (error) => {
		const now = clock();
		recent = [...recent.filter((at) => now - at < CRASH_WINDOW_MS), now];
		options.log?.write(
			`${new Date(now).toISOString()} ${kind}: ${redactSecrets(String((error as Error)?.stack ?? error)).slice(0, 2000)}\n`,
		);
		if (recent.length > CRASH_LIMIT) options.stop();
	};
}

/** A per-connection error must not end a daemon that holds every open tab: it is logged to `web/daemon.log` (size-capped). */
function keepServing(running: RunningDaemon, env: NodeJS.ProcessEnv): void {
	let log: RotatingLog | undefined;
	try {
		log = new RotatingLog(path.join(webDaemonPaths(env).dir, "daemon.log"), 256 * 1024, "lines");
	} catch {
		// No log to write; the daemon still survives.
	}
	const guard = crashGuard({ log, stop: () => void running.shutdown().finally(() => process.exit(1)) });
	process.on("uncaughtException", guard("uncaughtException"));
	process.on("unhandledRejection", guard("unhandledRejection"));
}

/**
 * The name the daemon gives its process, `octocode-agent-web-<pid>`, so `ps`, `pgrep -f octocode-agent` and `/processes`
 * list it as Octocode's own (and a session's samples never record it as an orphan child). Inside this repository's test
 * runs it keeps its command line: on macOS `ps` shows no environment for a renamed process, and the run's teardown finds
 * a daemon a test left running by its environment.
 */
export function daemonProcessTitle(env: NodeJS.ProcessEnv, pid: number): string | undefined {
	if (env[TEST_GUARD_FILE_ENV] || env[TEST_PROTECTED_HOMES_ENV]) return undefined;
	return processTitle(WEB_DAEMON_ROLE, String(pid));
}

/** The detached process's entry: serve until idle, drained or signalled, then exit. */
export async function runWebDaemon(
	env: NodeJS.ProcessEnv = process.env,
	options: { page?: DaemonPage } = {},
): Promise<void> {
	const running = await startWebDaemon(env, options);
	if (!running) return;
	const title = daemonProcessTitle(env, process.pid);
	if (title) setProcessTitle(title);
	const stop = () => void running.shutdown();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	keepServing(running, env);
	await running.stopped;
	process.exit(0);
}
