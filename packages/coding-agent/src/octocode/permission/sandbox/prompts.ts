import {
	classifyHost,
	type HostLookup,
	lookupWithin,
	metadataRefusal,
	reachesMetadata,
} from "@octocodeai/octocode-common/web-guard";
import type { FeatureContext } from "../../../core/features/index.ts";
import { say } from "../../shared/commands.ts";
import type { Permission } from "../ask.ts";
import { shellNetwork } from "./policy.ts";
import type { HostAnswer, SandboxPrompts } from "./srt.ts";

/** How long resolving a host for its class may take before the connection is refused. */
const LOOKUP_MS = 5000;

/** `host` and `port` as a URL `classifyHost` reads; an IPv6 literal goes in brackets. */
const hostUrl = (host: string, port: number | undefined): URL =>
	new URL(`http://${host.includes(":") ? `[${host}]` : host}${port ? `:${port}` : ""}`);

/**
 * The sandbox's questions, answered through this session's permission checks. A connection asks as `net.shell` (a
 * private address as `net.private`, a cloud metadata address is refused in every mode) with a session grant per host;
 * `full` allows and records each. A read-only child's shell has no network. When the sandbox cannot start, a warning
 * says why and `shell.unsandboxed` asks once whether this session's commands run without it.
 */
export function sandboxPrompts(
	permission: Permission,
	ctx: FeatureContext,
	{ env = process.env, lookup }: { env?: NodeJS.ProcessEnv; lookup?: HostLookup } = {},
): SandboxPrompts {
	return {
		async host({ host, port, commands }): Promise<HostAnswer> {
			if (shellNetwork(permission.mode, env) === "none")
				return { allow: false, reason: "a read-only subagent's shell commands have no network" };
			const url = hostUrl(host, port);
			const signal = AbortSignal.timeout(LOOKUP_MS);
			const resolve = lookupWithin(lookup, signal);
			if (await reachesMetadata(url, resolve)) {
				const refusal = metadataRefusal(host);
				permission.refused([`shell connection ${url.host}`], refusal, "bash");
				return { allow: false, reason: refusal };
			}
			const privateHost = (await classifyHost(url, resolve)).kind === "private";
			const verdict = await permission.check(ctx, {
				action: privateHost ? "net.private" : "net.shell",
				title: privateHost
					? "Let a shell command reach a private address?"
					: "Let a shell command connect to this host?",
				what: [url.host, ...commands.map((command) => `command: ${command}`)],
				grant: { key: `shell\0${host}`, label: `shell connections to ${host}` },
				cwd: ctx.cwd,
			});
			if (!verdict.allowed) return { allow: false, reason: verdict.message };
			return { allow: true, scope: verdict.lasts === "session" ? "session" : "once" };
		},
		async unavailable(reason) {
			say(ctx, `The command sandbox cannot start: ${reason}.`, "warning");
			const verdict = await permission.check(ctx, {
				action: "shell.unsandboxed",
				title: "Run this session's shell commands without the sandbox?",
				what: [`every agent shell command this session, because ${reason}`],
				cwd: ctx.cwd,
			});
			return verdict.allowed;
		},
	};
}
