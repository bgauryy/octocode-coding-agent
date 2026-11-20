import { randomBytes } from "node:crypto";
import type * as SrtModule from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig as RuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { CommandSandbox, CommandSandboxRequest, SandboxedLaunch } from "../../../utils/command-sandbox.ts";
import { linuxStart, unsupportedPlatform } from "./linux.ts";
import { literalPolicy } from "./linux-paths.ts";
import { type SandboxPolicy, sandboxTempDir } from "./policy.ts";
import { withSocketFriendlyTempDir } from "./socket-dir.ts";
import { commandDenials } from "./violations.ts";

type Srt = typeof SrtModule;

/** How a connection to a host was answered: allowed for this connection (and the commands running now) or the session, or refused. */
export type HostAnswer = { allow: true; scope: "once" | "session" } | { allow: false; reason: string };

/** What the sandbox asks the session about. */
export interface SandboxPrompts {
	/**
	 * A sandboxed command connects to `host` and no rule allows it. The library does not say which command connects, so
	 * `commands` lists every sandboxed command running now.
	 */
	host(target: { host: string; port: number | undefined; commands: string[] }): Promise<HostAnswer>;
	/** The sandbox cannot start (`reason`): true runs this session's commands unsandboxed. Asked once per session. */
	unavailable(reason: string): Promise<boolean>;
}

/**
 * The configuration the library starts with; each command brings its own filesystem rules (`wrap`). An empty
 * `allowedDomains` turns the proxy on: every host goes to `askHost` (or a command's own list), and a command that
 * skips the proxy is refused by the Seatbelt profile. Loopback stays open (`allowLocalBinding`), so a test server and
 * its client both work; the library's `NO_PROXY` is narrowed to loopback in `wrap`, so private addresses reach the
 * proxy and are asked about too.
 */
function baseConfig(): RuntimeConfig {
	return {
		filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
		network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
	};
}

/** What a sandboxed command finds in `NO_PROXY`: loopback only, which it reaches directly. */
const LOOPBACK = "localhost,127.0.0.1,::1";

type HostReply = true | { allow: false; reason: string };

/** The library is one per process: started once, its ask callback answered by the sandbox constructed last. */
let library: Promise<Srt> | undefined;
let answerer: ((host: string, port: number | undefined) => Promise<HostReply>) | undefined;

/** The library's ask callback: a stable function, so a later session's `initialize` matches the first. */
async function askHost({ host, port }: { host: string; port: number | undefined }): Promise<HostReply> {
	return answerer ? answerer(host, port) : { allow: false, reason: "no session can answer" };
}

function startLibrary(): Promise<Srt> {
	library ??= (async () => {
		const srt = await import("@anthropic-ai/sandbox-runtime");
		// Linux adds bubblewrap's checks and the ripgrep its nested-repository scan runs.
		const linux =
			process.platform === "linux" ? linuxStart((ripgrep) => srt.SandboxManager.checkDependencies(ripgrep)) : undefined;
		if (!linux) {
			const { errors } = srt.SandboxManager.checkDependencies();
			if (errors.length > 0) throw new Error(`The command sandbox cannot start: ${errors.join("; ")}.`);
		}
		// srt reads the child's TMPDIR from this name at each wrap; see `sandboxTempDir`.
		process.env.CLAUDE_CODE_TMPDIR = sandboxTempDir();
		// The log monitor reports Seatbelt denials, which name the refused path in the command's result.
		// The proxy binds a Unix socket in the temporary folder, which a long `TMPDIR` makes too long for a socket path.
		await withSocketFriendlyTempDir(() => srt.SandboxManager.initialize({ ...baseConfig(), ...linux }, askHost, true));
		return srt;
	})().catch((error: unknown) => {
		library = undefined;
		throw error;
	});
	return library;
}

/** The variables the library sets for a command: what differs from this process's environment, `NO_PROXY` narrowed. */
function launchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const set: Record<string, string> = {};
	for (const [key, value] of Object.entries(env))
		if (value !== undefined && process.env[key] !== value) set[key] = value;
	if ("NO_PROXY" in set) set.NO_PROXY = LOOPBACK;
	if ("no_proxy" in set) set.no_proxy = LOOPBACK;
	return set;
}

interface Live {
	command: string;
	hosts: Set<string>;
}

/**
 * `CommandSandbox` over `@anthropic-ai/sandbox-runtime` (srt): a Seatbelt profile per command on macOS, a bubblewrap
 * sandbox on Linux (its wildcard rules made literal, `literalPolicy`), from the policy `policyFor` derives for the command's folder at that moment (the permission mode can change between
 * commands), with its network through the library's proxy. The library is loaded and started on the first sandboxed
 * command, so a session that never sandboxes pays nothing for it. Constructing one makes it the sandbox that answers
 * the proxy's questions.
 */
export class SrtCommandSandbox implements CommandSandbox {
	readonly allowsUnsandboxed: boolean;
	private readonly policyFor: (cwd: string) => SandboxPolicy | undefined;
	private readonly prompts: SandboxPrompts | undefined;
	/** The answer to `prompts.unavailable`, asked once. */
	private escape: Promise<boolean> | undefined;
	/** Running commands by id, with the hosts allowed for them alone. */
	private readonly live = new Map<string, Live>();
	/** Questions in flight by `host:port`, so concurrent connections share one ask. */
	private readonly asking = new Map<string, Promise<HostReply>>();

	/**
	 * `policyFor` returns undefined for a command that runs unsandboxed, and throws when one cannot run at all. Without
	 * `prompts` every host the configuration does not allow is refused, and a sandbox that cannot start refuses commands.
	 */
	constructor(
		policyFor: (cwd: string) => SandboxPolicy | undefined,
		{ prompts, allowsUnsandboxed = true }: { prompts?: SandboxPrompts; allowsUnsandboxed?: boolean } = {},
	) {
		this.policyFor = policyFor;
		this.prompts = prompts;
		this.allowsUnsandboxed = allowsUnsandboxed;
		answerer = (host, port) => this.answerHost(host, port);
	}

	/** Answers the proxy for a host no rule allowed; an allow "once" also lets the commands running now reach it again. */
	private answerHost(host: string, port: number | undefined): Promise<HostReply> {
		const key = `${host}:${port ?? ""}`;
		const pending = this.asking.get(key);
		if (pending) return pending;
		const answer = (async () => {
			if (!this.prompts) return { allow: false as const, reason: "host is not on the allow list" };
			const commands = [...this.live.values()].map((each) => each.command);
			const answered = await this.prompts.host({ host, port, commands });
			if (!answered.allow) return answered;
			if (answered.scope === "once") await this.allowForRunning(host);
			return true as const;
		})().finally(() => this.asking.delete(key));
		this.asking.set(key, answer);
		return answer;
	}

	private async allowForRunning(host: string): Promise<void> {
		const srt = await startLibrary();
		for (const [id, each] of this.live) {
			each.hosts.add(host);
			try {
				srt.SandboxManager.registerCommandNetworkLists(id, { allowedDomains: [...each.hosts] });
			} catch {
				// A host the library takes for no domain pattern (an IPv6 literal) is asked again on its next connection.
				each.hosts.delete(host);
			}
		}
	}

	private async start(): Promise<Srt | undefined> {
		let reason: string;
		const unsupported = unsupportedPlatform();
		if (unsupported) reason = unsupported;
		else
			try {
				return await startLibrary();
			} catch (error) {
				reason = errorMessage(error);
			}
		const refused = `sandbox.mode sandboxes this command, but ${reason}. The command was not run`;
		if (!this.prompts) throw new Error(`${refused}; set sandbox.mode to "off" to run commands unsandboxed.`);
		if (!this.allowsUnsandboxed)
			throw new Error(
				`${refused}: sandbox.allowUnsandboxed is false. Set sandbox.mode to "off" to run commands unsandboxed.`,
			);
		this.escape ??= this.prompts.unavailable(reason);
		if (await this.escape) return undefined;
		throw new Error(`${refused}: running commands unsandboxed was not allowed for this session.`);
	}

	async wrap(request: CommandSandboxRequest): Promise<SandboxedLaunch | undefined> {
		const policy = this.policyFor(request.cwd);
		if (!policy) return undefined;
		if (request.viaStdin || request.shellArgs.length !== 1 || request.shellArgs[0] !== "-c")
			throw new Error(
				`The command sandbox runs a shell as \`${request.shell} -c <command>\` only; this shell takes ${request.viaStdin ? "its command on stdin" : `the arguments ${request.shellArgs.join(" ")}`}. The command was not run.`,
			);
		const srt = await this.start();
		if (!srt) return undefined;
		// Unguessable (the library's rule for an id an allow list is registered under) and unique, so denials are this command's.
		const commandId = randomBytes(16).toString("base64url");
		const manager = srt.SandboxManager;
		const linux = process.platform === "linux";
		// On Linux the library makes mount points for denied paths that do not exist yet; each wrap's are removed after it.
		const unmount = () => {
			if (linux) manager.cleanupAfterCommand();
		};
		const { argv, env } = await manager.wrapWithSandboxArgv(
			request.command,
			request.shell,
			{ filesystem: linux ? literalPolicy(policy) : policy },
			undefined,
			request.cwd,
			{ commandId, commandText: request.command },
		);
		const [file, ...args] = argv;
		if (file === undefined) {
			unmount();
			throw new Error("The command sandbox returned no program to run. The command was not run.");
		}
		this.live.set(commandId, { command: request.command, hosts: new Set() });
		manager.registerCommandNetworkLists(commandId, { allowedDomains: [] });
		let released = false;
		return {
			file,
			args,
			env: launchEnv(env),
			release: () => {
				if (released) return;
				released = true;
				this.live.delete(commandId);
				manager.unregisterCommandNetworkLists(commandId);
				unmount();
			},
			denials: (wait) => commandDenials(manager.getSandboxViolationStore(), commandId, { wait }),
		};
	}
}
