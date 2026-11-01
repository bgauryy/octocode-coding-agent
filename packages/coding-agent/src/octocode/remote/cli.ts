import { Value } from "typebox/value";
import {
	DaemonSessionsSchema,
	RemoteLinkSchema,
	RemoteStatusSchema,
	type RemotePublish,
} from "@octocodeai/octocode-contracts/daemon";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { daemonRequest, findWebDaemon, type LaunchedDaemon } from "../web-daemon/launcher.ts";
import { describeLink, describeStatus } from "./links.ts";

const USAGE = `Usage: octocode remote <command>
  list [--json]                       Sessions the web daemon reaches, blocked ones first, and the published links
                                      (by fingerprint; a link is printed in full only when it is published)
  link [view] [--relay <ws(s) url>]   Publish a control (or view) link; --relay dials that relay instead of SSH
  stop                                Stop publishing; every link stops working
Needs a running web daemon (a session started with OCTOCODE_WEB_DAEMON=1).`;

async function read(daemon: LaunchedDaemon, route: string, options?: { method: "POST" | "DELETE"; body?: unknown }) {
	const response = await daemonRequest(daemon, route, options);
	if (!response) throw new Error("The web daemon did not answer.");
	const body = response.json() as { error?: string } | undefined;
	if (response.status !== 200) throw new Error(body?.error ?? `The web daemon answered ${response.status}.`);
	return body as unknown;
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
	const daemon = await findWebDaemon(env);
	if (!daemon) {
		io.err("No web daemon is running. Start a session with OCTOCODE_WEB_DAEMON=1 and run /web or /remote.");
		return 2;
	}
	try {
		if (command === "list") {
			const sessions = await read(daemon, DAEMON_ROUTES.sessions);
			const remote = await read(daemon, DAEMON_ROUTES.remote);
			if (!Value.Check(DaemonSessionsSchema, sessions) || !Value.Check(RemoteStatusSchema, remote))
				throw new Error("The web daemon's answer was not understood.");
			if (rest.includes("--json")) {
				io.out(JSON.stringify({ sessions: sessions.sessions, unavailable: sessions.unavailable ?? [], remote }));
				return 0;
			}
			const rows = sessions.sessions.map(
				(session) =>
					`${session.needsYou ? "needs you" : session.busy ? "working" : "idle"}\t${session.id}\t${session.repoName}\t${session.cwd}${session.needsYou ? `\t${session.needsYou}` : ""}`,
			);
			io.out(rows.length ? rows.join("\n") : "No sessions are attached to the web daemon.");
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
