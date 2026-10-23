import type { RpcCommand } from "../rpc-types.ts";
import type { JsonAgentSessionEvent } from "../../json-event.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
export type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Executable and argument prefix for source or standalone CLIs; takes precedence over cliPath. */
	invocation?: { command: string; args: string[] };
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
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

export type RpcEventListener = (event: JsonAgentSessionEvent) => void;
