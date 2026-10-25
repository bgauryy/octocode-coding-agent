import type { JsonRpcId } from "../protocol/jsonrpc.ts";
import type {
	ClientCapabilities,
	Implementation,
	ProgressNotification,
	Root,
	SupportedProtocolVersion,
} from "../protocol/types.ts";

export type ClientState = "idle" | "connecting" | "connected" | "closed";
export type NotificationListener = (params: unknown) => void;
export type ErrorListener = (error: Error) => void;
export type CloseListener = () => void;
/** May return a value or a promise of one. */
export type RequestHandler = (params: unknown, context: { signal: AbortSignal }) => unknown;

export interface McpClientOptions extends Implementation {
	capabilities?: ClientCapabilities;
	protocolVersion?: SupportedProtocolVersion;
	requestTimeoutMs?: number;
	/** The longest any request may take in total, progress included; `Infinity` removes the cap. Default 30 minutes. */
	maxTotalTimeoutMs?: number;
	roots?: readonly Root[] | (() => readonly Root[] | Promise<readonly Root[]>);
}

export interface McpRequestOptions {
	signal?: AbortSignal;
	/** Idle timeout: renewed by each progress notification. */
	timeoutMs?: number;
	/** Total timeout: progress does not extend it. */
	maxTotalTimeoutMs?: number;
	onProgress?: (progress: ProgressNotification) => void;
}

export interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timeoutMs: number;
	maxTotalTimeoutMs: number;
	/** When the total timeout ends (epoch ms), or Infinity. */
	deadline: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	signal: AbortSignal | undefined;
	onAbort: () => void;
	/** Aborted when the request settles, so the transport does not dispatch (or retry) it afterwards. */
	sendController: AbortController;
	cancellable: boolean;
	onProgress: ((progress: ProgressNotification) => void) | undefined;
	progressToken: JsonRpcId | undefined;
}
