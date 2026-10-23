import type { ChildProcessWithoutNullStreams } from "node:child_process";

const MAX_HEADER = 1024;
const MAX_BODY = 1024 * 1024;
const MAX_BUFFER = MAX_BODY + MAX_HEADER;
const DEADLINE_MS = 10_000;

export type DapMessage = Record<string, unknown>;

/** One bounded stdio DAP connection; never interprets reverse requests as authority to run commands. */
export class DapProtocol {
	#buffer = Buffer.alloc(0);
	#sequence = 0;
	#closed?: Error;
	#pending = new Map<
		number,
		{ command: string; resolve: (message: DapMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
	>();
	#killTimer?: NodeJS.Timeout;
	#events = new Map<string, Array<(message: DapMessage) => void>>();
	#closedListeners: Array<() => void> = [];
	readonly child: ChildProcessWithoutNullStreams;
	constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.#feed(chunk));
		for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", (error) => this.close(error));
		child.on("error", (error) => this.close(error));
		child.on("exit", (code, signal) => {
			if (this.#killTimer) clearTimeout(this.#killTimer);
			this.close(new Error(`DAP adapter exited (${signal ?? code ?? "unknown"})`));
		});
	}

	on(event: string, listener: (message: DapMessage) => void): () => void {
		const listeners = this.#events.get(event) ?? [];
		listeners.push(listener);
		this.#events.set(event, listeners);
		return () =>
			this.#events.set(
				event,
				listeners.filter((item) => item !== listener),
			);
	}

	onClose(listener: () => void): void {
		if (this.#closed) listener();
		else this.#closedListeners.push(listener);
	}

	request(command: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<DapMessage> {
		if (this.#closed) return Promise.reject(this.#closed);
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("DAP request aborted"));
		if (this.#pending.size >= 32) return Promise.reject(new Error("Too many pending DAP requests"));
		const seq = ++this.#sequence;
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.#pending.delete(seq);
				clearTimeout(timer);
				reject(new Error("DAP request aborted"));
			};
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", abort);
				this.#pending.delete(seq);
				reject(new Error(`DAP ${command} timed out`));
			}, DEADLINE_MS);
			this.#pending.set(seq, {
				command,
				resolve: (message) => {
					signal?.removeEventListener("abort", abort);
					resolve(message);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", abort);
					reject(error);
				},
				timer,
			});
			signal?.addEventListener("abort", abort, { once: true });
			try {
				this.#send({ seq, type: "request", command, arguments: args });
			} catch (error) {
				abort();
			}
		});
	}

	#send(message: DapMessage): void {
		const body = Buffer.from(JSON.stringify(message), "utf8");
		if (body.byteLength > MAX_BODY) throw new Error("DAP request exceeds byte limit");
		this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`), body]));
	}

	#feed(chunk: Buffer): void {
		if (this.#closed) return;
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		if (this.#buffer.length > MAX_BUFFER) return this.close(new Error("DAP receive buffer exceeded limit"));
		while (this.#buffer.length) {
			const headerEnd = this.#buffer.indexOf("\r\n\r\n");
			if (headerEnd < 0) {
				if (this.#buffer.length > MAX_HEADER) this.close(new Error("DAP header exceeded limit"));
				return;
			}
			if (headerEnd > MAX_HEADER) return this.close(new Error("DAP header exceeded limit"));
			const header = this.#buffer.subarray(0, headerEnd).toString("ascii");
			const match = /^Content-Length: ([1-9]\d*)\r?$/im.exec(header);
			if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) > MAX_BODY)
				return this.close(new Error("Invalid DAP Content-Length"));
			const length = Number(match[1]);
			if (this.#buffer.length < headerEnd + 4 + length) return;
			const bytes = this.#buffer.subarray(headerEnd + 4, headerEnd + 4 + length);
			this.#buffer = this.#buffer.subarray(headerEnd + 4 + length);
			let message: DapMessage;
			try {
				const parsed: unknown = JSON.parse(bytes.toString("utf8"));
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid DAP message");
				message = parsed as DapMessage;
			} catch {
				return this.close(new Error("Invalid DAP JSON message"));
			}
			this.#dispatch(message);
			if (this.#closed) return;
		}
	}

	#dispatch(message: DapMessage): void {
		if (message.type === "response") {
			const pending = this.#pending.get(message.request_seq as number);
			if (!pending) return;
			if (message.command !== pending.command) return this.close(new Error("DAP response command mismatch"));
			this.#pending.delete(message.request_seq as number);
			clearTimeout(pending.timer);
			if (message.success === false)
				pending.reject(
					new Error(
						`DAP ${String(message.command)} failed: ${typeof message.message === "string" ? message.message : "unknown error"}`,
					),
				);
			else pending.resolve(message);
		} else if (message.type === "event" && typeof message.event === "string") {
			for (const listener of this.#events.get(message.event) ?? []) listener(message);
		} else if (message.type === "request" && typeof message.seq === "number") {
			// In particular, never honor runInTerminal from an adapter.
			try {
				this.#send({
					seq: ++this.#sequence,
					type: "response",
					request_seq: message.seq,
					command: message.command,
					success: false,
					message: "Reverse requests are unsupported",
				});
			} catch {
				this.close(new Error("DAP reverse request rejection failed"));
			}
		}
	}

	close(error = new Error("DAP session closed")): void {
		if (this.#closed) return;
		this.#closed = error;
		for (const listener of this.#closedListeners.splice(0)) listener();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		this.child.stdin.destroy();
		this.child.stdout.destroy();
		this.child.stderr.destroy();
		if (this.child.exitCode === null) {
			if (!this.child.killed) this.child.kill();
			this.#killTimer = setTimeout(() => {
				if (this.child.exitCode === null) this.child.kill("SIGKILL");
			}, 1000);
			this.#killTimer.unref();
		}
	}
}
