import { Value } from "typebox/value";
import {
	type DaemonSession,
	DaemonSessionsSchema,
	RemoteLinkSchema,
	RemoteStatusSchema,
	type RemotePublish,
} from "@octocodeai/octocode-contracts/daemon";
import { activity } from "@octocodeai/octocode-projections";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { daemonRequest, findWebDaemon, type LaunchedDaemon } from "../web-daemon/launcher.ts";
import { describeLink, describeStatus } from "./links.ts";

const USAGE = `Usage: octocode remote <command>
  list [--json]                       Sessions the web daemon reaches, blocked ones first, and the published links
                                      (by fingerprint; a link is printed in full only when it is published)
  link [view] [--relay <ws(s) url>]   Publish a control (or view) link; --relay dials that relay instead of SSH
  stop                                Stop publishing; every link stops working
Needs a running web daemon: run /web or /remote in an Octocode session to start it.
Exit status: 0 done, 1 usage or a request the daemon refused, 2 no web daemon is running (list --json still prints JSON).`;

/** The text listing's first line: the columns `remoteSessionRow` writes, tab-separated. */
const REMOTE_LIST_HEADER = ["ACTIVITY", "SESSION", "REPOSITORY", "FOLDER", "DIALOG"].join("\t");

/** What `remote list --json` prints when no daemon runs: the same shape, empty, with `daemon: null`. */
const NO_DAEMON_LIST = { daemon: null, sessions: [], unavailable: [], remote: { links: [] } };

async function read(daemon: LaunchedDaemon, route: string, options?: { method: "POST" | "DELETE"; body?: unknown }) {
	const response = await daemonRequest(daemon, route, options);
	if (!response) throw new Error("The web daemon did not answer.");
	const body = response.json() as { error?: string } | undefined;
	if (response.status !== 200) throw new Error(body?.error ?? `The web daemon answered ${response.status}.`);
	return body as unknown;
}

/**
 * One `remote list` line: the session's light in the shared words (`activity`; from `busy` and `needsYou` when the daemon
 * sent no light), its id, repository and folder, then the dialog's title when one waits. Tab-separated for scripts.
 */
export function remoteSessionRow(session: DaemonSession): string {
	const shown = session.activity ?? activity({ awaiting: Boolean(session.needsYou), streaming: session.busy });
	return [shown.label, session.id, session.repoName, session.cwd, ...(session.needsYou ? [session.needsYou] : [])].join(
		"\t",
	);
}

/** What `remote list` prints for the sessions: the column header and one row each, or a line that says none is attached. */
export function remoteSessionsText(sessions: readonly DaemonSession[]): string {
	if (sessions.length === 0) return "No sessions are attached to the web daemon.";
	return [REMOTE_LIST_HEADER, ...sessions.map(remoteSessionRow)].join("\n");
}

/** `octocode remote ...` for scripts and other agents: no session, no UI, the daemon's own answers. */
export async function runRemoteCli(
	args: string[],
	env: NodeJS.ProcessEnv = process.env,
	io: { out(text: string): void; err(text: string): void } = {
		out: (text) => process.stdout.write(`${text}\n`),
		err: (text) => process.stderr.write(`${text}\n`),
	},
): Promise<number> {
	const [command, ...rest] = args;
	if (!command || command === "--help" || command === "-h") {
		io.out(USAGE);
		return command ? 0 : 1;
	}
	if (command !== "list" && command !== "link" && command !== "stop") {
		io.err(USAGE);
		return 1;
	}
	const json = command === "list" && rest.includes("--json");
	const daemon = await findWebDaemon(env);
	if (!daemon) {
		// A script that asked for JSON parses one shape either way; the exit status still says no daemon runs.
		if (json) io.out(JSON.stringify(NO_DAEMON_LIST));
		io.err("No web daemon is running. Run /web or /remote in an Octocode session to start it.");
		return 2;
	}
	try {
		if (command === "list") {
			const sessions = await read(daemon, DAEMON_ROUTES.sessions);
			const remote = await read(daemon, DAEMON_ROUTES.remote);
			if (!Value.Check(DaemonSessionsSchema, sessions) || !Value.Check(RemoteStatusSchema, remote))
				throw new Error("The web daemon's answer was not understood.");
			if (json) {
				io.out(
					JSON.stringify({
						daemon: { pid: daemon.record.pid, port: daemon.record.port },
						sessions: sessions.sessions,
						unavailable: sessions.unavailable ?? [],
						...(sessions.truncated ? { truncated: true } : {}),
						remote,
					}),
				);
				return 0;
			}
			io.out(remoteSessionsText(sessions.sessions));
			io.out(describeStatus(remote));
			return 0;
		}
		if (command === "stop") {
			await read(daemon, DAEMON_ROUTES.remote, { method: "DELETE" });
			io.out("Stopped publishing.");
			return 0;
		}
		const relayAt = rest.indexOf("--relay");
		const relayUrl = relayAt >= 0 ? rest[relayAt + 1] : undefined;
		if (relayAt >= 0 && !relayUrl) throw new Error("--relay needs a ws:// or wss:// address.");
		const request: RemotePublish = {
			transport: relayUrl ? "relay" : "ssh",
			access: rest.includes("view") ? "view" : "control",
			...(relayUrl ? { relayUrl } : {}),
		};
		const published = (await read(daemon, DAEMON_ROUTES.remote, { method: "POST", body: request })) as {
			link?: unknown;
		};
		if (!Value.Check(RemoteLinkSchema, published.link)) throw new Error("The web daemon's answer was not understood.");
		io.out(describeLink(published.link, { qr: !rest.includes("--no-qr") }));
		return 0;
	} catch (error) {
		io.err(errorMessage(error));
		return 1;
	}
}
