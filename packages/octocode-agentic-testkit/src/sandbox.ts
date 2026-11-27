import { randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type * as SrtModule from "@anthropic-ai/sandbox-runtime";
import type { FilesystemConfig, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

type Srt = typeof SrtModule;
type PathEntry = FilesystemConfig["denyRead"][number];

/**
 * What a sandboxed process may touch. Reads are open except `denyRead` (plus `DEFAULT_DENY_READ`); writes are closed
 * except `writable`; the network reaches loopback (the gateway, mock MCP servers) and the hosts in `network.allow`.
 */
export interface SandboxOptions {
	/** The run's temp root, where HOME, config and TMPDIR live. Defaults to the run's HOME. */
	root?: string;
	/** Paths the process may write. Replaces the default: `root` and the workspace (`cwd`). */
	writable?: string[];
	/** Extra paths (globs allowed) the process may not read, on top of `DEFAULT_DENY_READ`. */
	denyRead?: string[];
	/** Paths readable again inside a denied path. */
	readable?: string[];
	/** Hosts beyond loopback the process may reach: exact names or `*.example.com`. Default: none. */
	network?: { allow?: string[] };
}

/** Where a sandboxed process runs: its working directory, HOME and environment. */
interface SandboxTarget {
	cwd: string;
	home: string;
	env: Record<string, string>;
}

/** A command wrapped by the sandbox; `release` drops its network allow list once the process has exited. */
interface SandboxedLaunch {
	file: string;
	args: string[];
	release(): void;
}

/** Credential folders and files under the account's home that a sandboxed process may not read. */
export const DEFAULT_DENY_READ = [
	".ssh",
	".aws",
	".azure",
	".config/gcloud",
	".config/gh",
	".docker",
	".gnupg",
	".kube",
	".netrc",
	".git-credentials",
	".npmrc",
];

/**
 * Paths the library makes writable for its own caller (a shared `/tmp/claude`, home log folders). Closed again, so one
 * run cannot plant files another sandboxed process on this machine reads.
 */
const LIBRARY_SHARED_WRITES = (home: string): string[] => [
	"/tmp/claude",
	"/private/tmp/claude",
	join(home, ".claude", "debug"),
	join(home, ".npm", "_logs"),
];

/**
 * The configuration the library starts with, once per process. An empty `allowedDomains` turns the proxy on, and with
 * no ask callback every host outside a run's own list is refused; `allowLocalBinding` keeps loopback reachable.
 */
const BASE_CONFIG: SandboxRuntimeConfig = {
	filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
	network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
};

const requireModule = createRequire(import.meta.url);
const LIBRARY = "@anthropic-ai/sandbox-runtime";
let library: Srt | undefined;

/** Loads the library on first use only, so a suite that never sandboxes does not pay for it. */
function load(): Srt {
	library ??= requireModule(LIBRARY) as Srt;
	return library;
}

const errorCode = (e: unknown): unknown => (e as { code?: unknown } | null)?.code;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Why the sandbox cannot run on this machine, or undefined when it can. */
export function sandboxAvailable(): string | undefined {
	// On Linux the library isolates the network in a namespace, which hides the host's loopback the gateway listens on.
	if (process.platform !== "darwin")
		return `the process sandbox supports macOS only (this is ${process.platform}): elsewhere the host loopback is unreachable`;
	let srt: Srt;
	try {
		srt = load();
	} catch (e) {
		const code = errorCode(e);
		if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") throw e;
		return `${LIBRARY} is not installed: ${message(e)}`;
	}
	const { errors } = srt.SandboxManager.checkDependencies();
	return errors.length ? errors.join("; ") : undefined;
}

let started: Promise<Srt> | undefined;

function start(): Promise<Srt> {
	started ??= (async () => {
		const reason = sandboxAvailable();
		if (reason) throw new Error(`the process sandbox cannot start: ${reason}`);
		const srt = load();
		if (srt.SandboxManager.getConfig() !== undefined)
			throw new Error(
				`the process sandbox cannot start: ${LIBRARY} was already initialized in this process by another owner`,
			);
		await srt.SandboxManager.initialize(BASE_CONFIG, undefined, false);
		return srt;
	})().catch((e: unknown) => {
		started = undefined;
		throw e;
	});
	return started;
}

/** The path with symlinks resolved (`/var` is `/private/var` on macOS); a path that does not exist keeps its spelling. */
function real(p: string): string {
	try {
		return realpathSync(p);
	} catch (e) {
		if (errorCode(e) === "ENOENT") return p;
		throw e;
	}
}

const literal = (p: string): PathEntry => ({ path: real(p), literal: true });

function isExecutable(p: string): boolean {
	try {
		accessSync(p, constants.X_OK);
		return statSync(p).isFile();
	} catch (e) {
		const code = errorCode(e);
		if (code === "ENOENT" || code === "EACCES" || code === "ENOTDIR") return false;
		throw e;
	}
}

/**
 * The program `command` names, found on the run's `PATH` as `spawn` would. Inside the sandbox a missing program would
 * only be a shell's exit code 127; this keeps it the same rejection an unsandboxed run gives.
 */
function resolveCommand(command: string, target: SandboxTarget): string {
	const candidates = command.includes("/")
		? [resolve(target.cwd, command)]
		: (target.env.PATH ?? "")
				.split(delimiter)
				.filter(Boolean)
				.map((dir) => join(resolve(target.cwd, dir), command));
	const found = candidates.find(isExecutable);
	if (found) return found;
	throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT", path: command, syscall: "spawn" });
}

/** One POSIX shell word. */
const quote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

function filesystem(target: SandboxTarget, o: SandboxOptions): FilesystemConfig {
	const homes = [...new Set([userInfo().homedir, homedir()])];
	const root = o.root ?? target.home;
	return {
		allowWrite: o.writable?.map(literal) ?? [literal(root), literal(target.cwd)],
		denyWrite: homes.flatMap(LIBRARY_SHARED_WRITES).map(literal),
		denyRead: [...homes.flatMap((h) => DEFAULT_DENY_READ.map((rel) => literal(join(h, rel)))), ...(o.denyRead ?? [])],
		allowRead: o.readable ?? [],
	};
}

/**
 * Wraps `command args` in a Seatbelt profile from `o`, through the library's network proxy. The returned program is
 * run as given; call `release` once it has exited or failed to start. Throws, never runs unsandboxed, when the
 * sandbox cannot start.
 */
export async function sandboxLaunch(
	command: string,
	args: string[],
	target: SandboxTarget,
	o: SandboxOptions,
): Promise<SandboxedLaunch> {
	const srt = await start();
	const program = resolveCommand(command, target);
	// The library points TMPDIR at its shared folder, which stays closed: the run keeps its own.
	const tmp = target.env.TMPDIR ?? o.root ?? target.home;
	const inner = `TMPDIR=${quote(tmp)} exec ${[program, ...args].map(quote).join(" ")}`;
	// Unguessable (the library's rule for an id an allow list is registered under) and unique per run.
	const commandId = randomBytes(16).toString("base64url");
	const manager = srt.SandboxManager;
	const { argv } = await manager.wrapWithSandboxArgv(
		inner,
		"bash",
		{ filesystem: filesystem(target, o) },
		undefined,
		target.cwd,
		{ commandId, commandText: command },
	);
	const [file, ...wrapped] = argv;
	if (file === undefined) throw new Error("the process sandbox returned no program to run");
	manager.registerCommandNetworkLists(commandId, { allowedDomains: o.network?.allow ?? [] });
	let released = false;
	return {
		file,
		args: wrapped,
		release: () => {
			if (released) return;
			released = true;
			manager.unregisterCommandNetworkLists(commandId);
		},
	};
}
