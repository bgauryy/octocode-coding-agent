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
	/** Idle timeout, renewed on progress. Non-positive/nonfinite settings use the SDK's platform ceiling (~24.8 days). */
	timeoutMs?: number;
	/** Total timeout: progress does not extend it. */
	maxTotalTimeoutMs?: number;
	/** SDK progress payload; the opaque routing token remains available through notifications/progress. */
	onProgress?: (progress: Omit<ProgressNotification, "progressToken">) => void;
}
