import { Value } from "typebox/value";
import {
	RemoteLinkSchema,
	RemoteStatusSchema,
	type RemoteAccess,
	type RemoteLink,
	type RemotePublish,
	type RemoteStatus,
} from "@octocodeai/octocode-contracts/daemon";
import { DAEMON_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { RemoteSettings } from "../../core/settings-schema.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { say, type Subcommand, wordCompletions } from "../shared/commands.ts";
import { daemonRequest, type LaunchedDaemon } from "../web-daemon/launcher.ts";
import { describeLink, describeStatus } from "./links.ts";

export interface RemoteHost {
	/** The daemon with this session attached, started when none runs; rejects when it cannot start or be reached. */
	daemon(ctx: ExtensionContext): Promise<Pick<LaunchedDaemon, "origin" | "token">>;
	settings(): RemoteSettings;
}

async function answer<T>(
	daemon: Pick<LaunchedDaemon, "origin" | "token">,
	options: { method?: "GET" | "POST" | "DELETE"; body?: unknown },
	check: (value: unknown) => value is T,
): Promise<T> {
	const response = await daemonRequest(daemon, DAEMON_ROUTES.remote, options);
	if (!response) throw new Error("The web daemon did not answer.");
	const body = response.json();
	if (response.status !== 200) {
		const error = (body as { error?: string } | undefined)?.error;
		throw new Error(error ?? `The web daemon answered ${response.status}.`);
	}
	if (!check(body)) throw new Error("The web daemon's answer was not understood.");
	return body;
}

const isLinkAnswer = (value: unknown): value is { link: RemoteLink } =>
	typeof value === "object" && value !== null && Value.Check(RemoteLinkSchema, (value as { link?: unknown }).link);
const isStatus = (value: unknown): value is RemoteStatus => Value.Check(RemoteStatusSchema, value);

/** Publishes one link with the configured transport. */
async function publishLink(host: RemoteHost, ctx: ExtensionContext, access: RemoteAccess): Promise<RemoteLink> {
	const daemon = await host.daemon(ctx);
	const settings = host.settings();
	const request: RemotePublish = {
		transport: settings.transport ?? "ssh",
		access,
		...(settings.relayUrl ? { relayUrl: settings.relayUrl } : {}),
	};
	return (await answer(daemon, { method: "POST", body: request }, isLinkAnswer)).link;
}

/**
 * `/remote` publishes a control link to this machine's web daemon (every session, the board, approvals); `/remote view`
 * a read-only one; `/remote status` and `/remote stop`. The transport comes from `remote.transport`: `ssh` prints the
 * port forward to run, `relay` dials `remote.relayUrl`. Links are shown once, with a QR code to scan; `/remote status`
 * lists them by fingerprint only.
 */
export function remoteCommand(host: RemoteHost): Subcommand {
	return {
		description: "Share sessions with another device",
		complete: (prefix) =>
			wordCompletions(
				[
					["view", "A read-only link"],
					["status", "Published links and the relay"],
					["stop", "Stop publishing; every link dies"],
				],
				prefix,
			),
		async handler(args, ctx) {
			const word = args.trim();
			if (word && word !== "view" && word !== "status" && word !== "stop") {
				say(ctx, "Usage: /remote [view|status|stop]", "warning");
				return;
			}
			try {
				if (word === "status" || word === "stop") {
					const daemon = await host.daemon(ctx);
					if (word === "status") say(ctx, describeStatus(await answer(daemon, {}, isStatus)));
					else {
						await answer(daemon, { method: "DELETE" }, (value): value is unknown => value !== undefined);
						say(ctx, "Stopped publishing. Every link, view and control, no longer works.");
					}
					return;
				}
				const link = await publishLink(host, ctx, word === "view" ? "view" : "control");
				say(ctx, describeLink(link, { qr: ctx.hasUI }));
			} catch (error) {
				say(ctx, `Could not publish a remote link: ${errorMessage(error)}`, "error");
			}
		},
	};
}

/** `remote.autoStart`: publish a link when a session starts, and say where it is. Never for a subagent. */
export function registerRemoteAutoStart(api: ExtensionAPI, host: RemoteHost): void {
	api.on("session_start", async (_event, ctx) => {
		const access = host.settings().autoStart ?? "off";
		if (access === "off") return;
		try {
			say(ctx, describeLink(await publishLink(host, ctx, access)));
		} catch (error) {
			say(ctx, `Remote auto-start: ${errorMessage(error)}`, "warning");
		}
	});
}
