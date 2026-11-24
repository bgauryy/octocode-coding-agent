/**
 * Injectable WebSocket transport. Node/browser `WebSocket` cannot set an `Authorization`
 * header, which OpenAI-style realtime servers expect, so the caller supplies a transport
 * (for example one backed by the `ws` package) that honours `headers`.
 */
export interface RealtimeHandlers {
	onMessage(data: string): void;
	onClose(code: number, reason: string): void;
	onError(error: Error): void;
}

export interface RealtimeSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface RealtimeConnectRequest {
	url: string;
	headers: Record<string, string>;
	signal: AbortSignal;
	handlers: RealtimeHandlers;
}

export interface RealtimeTransport {
	/** Resolves once the socket is open; must reject if `signal` aborts first. */
	connect(request: RealtimeConnectRequest): Promise<RealtimeSocket>;
}
