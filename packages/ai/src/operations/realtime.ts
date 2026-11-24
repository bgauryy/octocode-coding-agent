import { type OperationClientConfig } from "./config.ts";
import { OperationError, redactSecrets } from "./errors.ts";
import { authHeaders, operationSecrets } from "./http.ts";
import type { RealtimeSocket, RealtimeTransport } from "./realtime-transport.ts";

export interface RealtimeConfig extends Omit<OperationClientConfig, "fetch"> {
	transport: RealtimeTransport;
	/** Max events buffered before the session fails. Default 1000. */
	maxQueuedEvents?: number;
	/** Max size of one incoming message in bytes. Default 16 MiB. */
	maxEventBytes?: number;
}

export type RealtimeEvent = { type: string; [key: string]: unknown };

export interface NextOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface RealtimeSession {
	send(event: RealtimeEvent): void;
	/** Next server event; `undefined` once the server closed cleanly. Throws on transport failure, timeout or abort. */
	next(options?: NextOptions): Promise<RealtimeEvent | undefined>;
	close(): void;
}

/** OpenAI caps one `input_audio_buffer.append` payload at 15 MiB of audio. */
export const MAX_AUDIO_CHUNK_BYTES = 15 * 1024 * 1024;

const OP = "realtime";
const sessionSecrets = new WeakMap<RealtimeSession, readonly (string | undefined)[]>();

function wsUrl(config: RealtimeConfig, model: string): string {
	let url: URL;
	try {
		url = new URL(`${config.baseUrl.replace(/\/+$/, "")}/realtime`);
	} catch {
		throw new OperationError("invalid_input", OP, "baseUrl is not a valid URL");
	}
	if (url.protocol === "https:") url.protocol = "wss:";
	else if (url.protocol === "http:") url.protocol = "ws:";
	if (url.protocol !== "wss:" && url.protocol !== "ws:") {
		throw new OperationError("invalid_input", OP, "baseUrl must use http(s) or ws(s)");
	}
	url.searchParams.set("model", model);
	return url.toString();
}

/** Opens a realtime session over the injected transport. Aborting `signal` closes it. */
export async function openRealtimeSession(
	config: RealtimeConfig,
	request: { model: string },
	options: { signal?: AbortSignal; connectTimeoutMs?: number } = {},
): Promise<RealtimeSession> {
	if (!request.model.trim()) throw new OperationError("invalid_input", OP, "model must not be empty");
	const url = wsUrl(config, request.model);
	const maxQueued = config.maxQueuedEvents ?? 1000;
	const maxBytes = config.maxEventBytes ?? 16 * 1024 * 1024;
	const secrets = operationSecrets(config);
	if (options.signal?.aborted) throw new OperationError("aborted", OP, "aborted before start");

	const queue: RealtimeEvent[] = [];
	let failure: OperationError | undefined;
	let closed = false;
	let socket: RealtimeSocket | undefined;
	const waiters: Array<() => void> = [];
	const wake = () => {
		for (const w of waiters.splice(0)) w();
	};
	const cleanupAbort = () => {
		options.signal?.removeEventListener("abort", onAbort);
		options.signal?.removeEventListener("abort", sessionAbort);
	};
	const fail = (error: OperationError) => {
		failure ??= error;
		closed = true;
		cleanupAbort();
		try {
			socket?.close(1011, "client error");
		} catch {
			// socket already gone
		}
		wake();
	};

	const controller = new AbortController();
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let connectTimedOut = false;
	const connectTimer = setTimeout(
		() => {
			connectTimedOut = true;
			controller.abort();
		},
		options.connectTimeoutMs ?? config.timeoutMs ?? 30_000,
	);

	try {
		socket = await config.transport.connect({
			url,
			headers: authHeaders(config),
			signal: controller.signal,
			handlers: {
				onMessage(data) {
					if (closed) return;
					if (Buffer.byteLength(data) > maxBytes)
						return fail(new OperationError("response_too_large", OP, `event exceeds ${maxBytes} bytes`));
					let parsed: unknown;
					try {
						parsed = JSON.parse(data);
					} catch {
						return fail(new OperationError("malformed_response", OP, "event is not valid JSON"));
					}
					if (
						typeof parsed !== "object" ||
						parsed === null ||
						typeof (parsed as { type?: unknown }).type !== "string"
					) {
						return fail(new OperationError("malformed_response", OP, "event lacks a string type"));
					}
					if (queue.length >= maxQueued) {
						queue.length = 0; // events were lost: surface the failure, not a partial stream
						return fail(new OperationError("transport", OP, `more than ${maxQueued} unread events`));
					}
					queue.push(parsed as RealtimeEvent);
					wake();
				},
				onClose(code, reason) {
					if (closed) return;
					closed = true;
					cleanupAbort();
					if (code !== 1000 && code !== 1005) {
						failure = new OperationError(
							"transport",
							OP,
							`closed with code ${code}: ${redactSecrets(reason.slice(0, 200), secrets)}`,
						);
					}
					wake();
				},
				onError(error) {
					fail(new OperationError("transport", OP, redactSecrets(error.message, secrets)));
				},
			},
		});
	} catch (error) {
		if (error instanceof OperationError) throw error;
		if (connectTimedOut) throw new OperationError("timeout", OP, "connect timed out");
		if (options.signal?.aborted) throw new OperationError("aborted", OP, "aborted");
		throw new OperationError(
			"transport",
			OP,
			redactSecrets(error instanceof Error ? error.message : String(error), secrets),
		);
	} finally {
		clearTimeout(connectTimer);
		options.signal?.removeEventListener("abort", onAbort);
	}

	function sessionAbort(): void {
		fail(new OperationError("aborted", OP, "aborted"));
	}
	const close = () => {
		cleanupAbort();
		if (!closed) {
			closed = true;
			try {
				socket?.close(1000, "client closed");
			} catch {
				// already closed
			}
		}
		wake();
	};
	options.signal?.addEventListener("abort", sessionAbort, { once: true });
	if (options.signal?.aborted) sessionAbort();

	const session: RealtimeSession = {
		send(event) {
			if (closed || !socket) throw failure ?? new OperationError("transport", OP, "session is closed");
			const text = JSON.stringify(event);
			if (Buffer.byteLength(text) > maxBytes)
				throw new OperationError("invalid_input", OP, `event exceeds ${maxBytes} bytes`);
			socket.send(text);
		},
		async next(opts = {}) {
			for (;;) {
				const event = queue.shift();
				if (event) return event;
				if (failure) throw failure;
				if (closed) return undefined;
				if (opts.signal?.aborted) throw new OperationError("aborted", OP, "aborted");
				await new Promise<void>((resolve, reject) => {
					const timer =
						opts.timeoutMs === undefined
							? undefined
							: setTimeout(
									() => settle(() => reject(new OperationError("timeout", OP, `no event within ${opts.timeoutMs} ms`))),
									opts.timeoutMs,
								);
					const onAbortNext = () => settle(() => reject(new OperationError("aborted", OP, "aborted")));
					const settle = (done: () => void) => {
						clearTimeout(timer);
						opts.signal?.removeEventListener("abort", onAbortNext);
						const i = waiters.indexOf(waiter);
						if (i >= 0) waiters.splice(i, 1);
						done();
					};
					const waiter = () => settle(resolve);
					waiters.push(waiter);
					opts.signal?.addEventListener("abort", onAbortNext, { once: true });
				});
			}
		},
		close,
	};
	sessionSecrets.set(session, secrets);
	return session;
}

/** Sends PCM/G.711 bytes as base64 `input_audio_buffer.append` events, split at `chunkBytes`. */
export function appendAudio(session: RealtimeSession, audio: Uint8Array, chunkBytes = 512 * 1024): void {
	if (audio.byteLength === 0) throw new OperationError("invalid_input", OP, "audio is empty");
	if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MAX_AUDIO_CHUNK_BYTES) {
		throw new OperationError("invalid_input", OP, `chunkBytes must be 1..${MAX_AUDIO_CHUNK_BYTES}`);
	}
	for (let i = 0; i < audio.byteLength; i += chunkBytes) {
		const audioB64 = Buffer.from(audio.subarray(i, i + chunkBytes)).toString("base64");
		session.send({ type: "input_audio_buffer.append", audio: audioB64 });
	}
}

/** Reads events until `response.done`; throws on a server `error` event. Returns every event seen. */
export async function collectResponse(session: RealtimeSession, options: NextOptions = {}): Promise<RealtimeEvent[]> {
	const events: RealtimeEvent[] = [];
	for (;;) {
		const event = await session.next(options);
		if (!event) throw new OperationError("transport", OP, "session closed before response.done");
		events.push(event);
		if (event.type === "error") {
			const err = event.error as { message?: unknown } | undefined;
			throw new OperationError(
				"transport",
				OP,
				`server error: ${typeof err?.message === "string" ? redactSecrets(err.message.slice(0, 300), sessionSecrets.get(session)) : "unknown"}`,
			);
		}
		if (event.type === "response.done") return events;
	}
}
