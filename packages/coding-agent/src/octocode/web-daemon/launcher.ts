import { spawn } from "node:child_process";
import http from "node:http";
import semver from "semver";
import { Value } from "typebox/value";
import {
	DAEMON_PROTOCOL_VERSION,
	DaemonStatusSchema,
	type DaemonRecord,
	type DaemonStatus,
} from "@octocodeai/octocode-contracts/daemon";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { getCliInvocation } from "../../config.ts";
import { acquireRegistryLock } from "../backlog/shared-web-lock.ts";
import { privateDir } from "../shared/home.ts";
import { daemonPage } from "./build.ts";
import { daemonSpawnOptions } from "./spawn-env.ts";
import { webDaemonPaths } from "./paths.ts";
import { readDaemonRecord, recordOrigin, recordProcessAlive, recordToken, removeRecord } from "./records.ts";

/** The hidden CLI subcommand that runs the daemon (`cli.ts`). */
const WEB_DAEMON_COMMAND = "__web-daemon";

const PROBE_MS = 1000;
const REQUEST_MS = 10_000;
const START_TIMEOUT_MS = 10_000;
const DRAIN_WAIT_MS = 5000;

export interface LaunchOptions {
	env?: NodeJS.ProcessEnv;
	/** The build a daemon must have to be reused; the current page's by default. */
	build?: string;
	/** How to start the daemon process; the CLI's own entry by default. */
	invocation?: { command: string; prefix: string[] };
}

export interface LaunchedDaemon {
	/** Loopback origin, e.g. `http://127.0.0.1:41234`. */
	origin: string;
	/** The launch capability for the page fragment. */
	token: string;
	record: DaemonRecord;
}

interface Live {
	record: DaemonRecord;
	status: DaemonStatus;
	origin: string;
	token: string;
}

interface Answer {
	status: number;
	json(): unknown;
}

/**
 * One request to the daemon over plain loopback HTTP. This deliberately avoids global `fetch`: a session installs a proxy-aware
 * dispatcher for it (`HTTP_PROXY`), and the daemon token must never be handed to a proxy. `node:http` with its own agent
 * connects straight to 127.0.0.1.
 */
function call(
	origin: string,
	route: string,
	token: string,
	method = "GET",
	body?: unknown,
	timeout = PROBE_MS,
): Promise<Answer | undefined> {
	return new Promise((resolve) => {
		const target = new URL(route, origin);
		const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
		const request = http.request(
			{
				host: "127.0.0.1",
				port: Number(target.port),
				path: target.pathname + target.search,
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
				},
				agent: new http.Agent({ keepAlive: false }),
				timeout,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("error", () => resolve(undefined));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						json: () => {
							try {
								return JSON.parse(Buffer.concat(chunks).toString("utf8"));
							} catch {
								return undefined;
							}
						},
					}),
				);
			},
		);
		request.on("timeout", () => request.destroy());
		request.on("error", () => resolve(undefined));
		if (payload) request.write(payload);
		request.end();
	});
}

/** One authenticated request to a daemon's own route; undefined when it did not answer. */
export function daemonRequest(
	daemon: Pick<LaunchedDaemon, "origin" | "token">,
	route: string,
	options: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {},
): Promise<{ status: number; json(): unknown } | undefined> {
	return call(daemon.origin, route, daemon.token, options.method ?? "GET", options.body, REQUEST_MS);
}

/** The daemon that is running now, if any; never starts one. */
export async function findWebDaemon(env: NodeJS.ProcessEnv = process.env): Promise<LaunchedDaemon | undefined> {
	const current = await live(webDaemonPaths(env).record);
	return current && { origin: current.origin, token: current.token, record: current.record };
}

/**
 * The daemon a record describes, when it is really that daemon: a loopback record, a process that may still be the
 * writer, and an authenticated health answer with the record's own nonce (the token is in the owner-only record, so no
 * stranger on the port can answer it; this also covers Windows, where pid start times are unknown).
 */
async function live(file: string): Promise<Live | undefined> {
	const record = readDaemonRecord(file);
	if (!record || !recordProcessAlive(record)) return undefined;
	const origin = recordOrigin(record);
	const token = recordToken(record);
	if (!origin || !token) return undefined;
	const response = await call(origin, DAEMON_ROUTES.health, token);
	if (response?.status !== 200) return undefined;
	const status: unknown = response.json();
	if (!Value.Check(DaemonStatusSchema, status) || status.nonce !== record.nonce || status.pid !== record.pid)
		return undefined;
	return { record, status, origin, token };
}

/** The package version in a build identity (`1.3.0:<page hash>`). */
const versionOf = (build: string): string | null => semver.valid(build.split(":")[0]);

/** Whether `launcher` is a newer package version than `daemon`; builds with no comparable version are never newer. */
function isNewer(launcher: string, daemon: string): boolean {
	const a = versionOf(launcher);
	const b = versionOf(daemon);
	return a !== null && b !== null && semver.gt(a, b);
}

/**
 * Whether a launcher of `build` can use this daemon. An older or equal launcher uses a running daemon as it is: only a
 * newer launcher drains an older daemon, so two installed versions never drain each other in turn.
 */
const usable = (daemon: Live, build: string): boolean =>
	daemon.status.protocolVersion === DAEMON_PROTOCOL_VERSION &&
	!daemon.status.draining &&
	(daemon.status.build === build || !isNewer(build, daemon.status.build));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns the running daemon, starting one if none runs. Launchers take `web/daemon.launch` so two racing launchers
 * produce one daemon; a daemon of another build is asked to drain first, and a record whose process is gone is removed.
 * The daemon is detached and outlives the process that launched it.
 */
export async function ensureWebDaemon(options: LaunchOptions = {}): Promise<LaunchedDaemon> {
	const env = options.env ?? process.env;
	const paths = webDaemonPaths(env);
	const build = options.build ?? daemonPage().build;
	const result = (daemon: Live): LaunchedDaemon => ({
		origin: daemon.origin,
		token: daemon.token,
		record: daemon.record,
	});
	const quick = await live(paths.record);
	if (quick && usable(quick, build)) return result(quick);
	privateDir(paths.dir);
	const release = await acquireRegistryLock(paths.launchLock, START_TIMEOUT_MS + DRAIN_WAIT_MS + 5000);
	try {
		let current = await live(paths.record);
		if (current && usable(current, build)) return result(current);
		if (current) {
			// Another build (or a draining one) holds the record: ask it to hand over, then wait for the record to go.
			await call(current.origin, DAEMON_ROUTES.drain, current.token, "POST");
			const deadline = Date.now() + DRAIN_WAIT_MS;
			while (Date.now() < deadline && readDaemonRecord(paths.record)?.nonce === current.record.nonce) await sleep(50);
			removeRecord(paths.record, (text) => text.includes(current!.record.nonce));
		} else {
			const stale = readDaemonRecord(paths.record);
			if (stale && !recordProcessAlive(stale)) removeRecord(paths.record);
		}
		const invocation = options.invocation ?? getCliInvocation();
		const { env: childEnv, cwd } = daemonSpawnOptions(env);
		let failed: Error | undefined;
		const child = spawn(invocation.command, [...invocation.prefix, WEB_DAEMON_COMMAND], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			env: childEnv,
			cwd,
		});
		child.once("error", (error) => (failed = error));
		child.once("exit", (code) => (failed ??= new Error(`The web daemon exited with code ${code} before it started.`)));
		child.unref();
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			current = await live(paths.record);
			if (current && usable(current, build)) return result(current);
			// A daemon that found another one running exits quietly; its record then answers the next check.
			if (failed) {
				current = await live(paths.record);
				if (current && usable(current, build)) return result(current);
				throw failed;
			}
			await sleep(50);
		}
		throw new Error("The web daemon did not start in time.");
	} finally {
		await release().catch(() => undefined);
	}
}

/** Waits (up to `ms`) until the daemon lists `sessionId` as attached, so the page it opens finds the session. */
export async function waitForSession(daemon: LaunchedDaemon, sessionId: string, ms = 4000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const response = await call(daemon.origin, DAEMON_ROUTES.sessions, daemon.token);
		const body = response?.json() as { sessions?: Array<{ id: string }> } | undefined;
		if (body?.sessions?.some((session) => session.id === sessionId)) return true;
		await sleep(100);
	}
	return false;
}
