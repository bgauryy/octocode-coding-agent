import type { RpcCommand, RpcExtensionErrorEvent } from "../rpc-types.ts";
import type { JsonAgentSessionEvent } from "../../json-event.ts";
import type { RpcReady } from "../session-identity.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
export type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Executable and argument prefix for source or standalone CLIs; takes precedence over cliPath. */
	invocation?: { command: string; args: string[] };
	/** Called with the session's first record: the protocol and Octocode versions and the session id. */
	onReady?: (ready: RpcReady) => void;
	/** Called with a failure the agent could not tie to a command; without this, it goes to stderr. */
	onProtocolError?: (message: string) => void;
	/** @internal Canonical identity announced by an ACP-owned worker before extension startup. */
	onSessionIdentity?: (sessionId: string) => void;
	/** Called with the id of a dialog the agent closed without this host's response (`extension_ui_dismiss`); close it. */
	onExtensionUIDismiss?: (id: string) => void;
	/** Path to the CLI entry point, run with `node` (default: `dist/bundle/cli.js`, relative to `cwd`) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Own the worker's whole process tree; stop gives native cleanup 10 seconds before killing survivors. */
	ownProcessTree?: boolean;
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEvent = JsonAgentSessionEvent | RpcExtensionErrorEvent;
export type RpcEventListener = (event: RpcEvent) => void;
