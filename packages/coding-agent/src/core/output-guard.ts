import { formatWithOptions } from "node:util";

interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();
let pendingRawStdoutWrites = 0;
let rawStdoutFailed = false;
let rawStdoutFailureHandler: ((error: Error) => void) | undefined;

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout);
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = (
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	};

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

export function writeRawStdout(text: string): void {
	void writeRawStdoutAsync(text).catch((error: Error) => {
		if (rawStdoutFailureHandler) rawStdoutFailureHandler(error);
		else process.exit(1);
	});
}

/**
 * Lets a protocol owner release its session when stdout fails, in place of the bare exit or the crash on the stream's
 * `error` event. Its reader is gone, so from then on waiting for stdout returns at once and nothing is written.
 * Returns a function that removes the handler. `handler` can be called more than once.
 */
export function onRawStdoutFailure(handler: (error: Error) => void): () => void {
	const onStreamError = (error: Error) => {
		rawStdoutFailed = true;
		handler(error);
	};
	rawStdoutFailureHandler = handler;
	process.stdout.on("error", onStreamError);
	return () => {
		rawStdoutFailureHandler = undefined;
		process.stdout.off("error", onStreamError);
	};
}

/** Whether a write is still on its way to stdout, so a reader is behind or the pipe is full. */
export function isRawStdoutWritePending(): boolean {
	return pendingRawStdoutWrites > 0;
}

/** Protocol owners await write failures so they can release their sessions before exiting. */
export function writeRawStdoutAsync(text: string): Promise<void> {
	if (text.length === 0) {
		return Promise.resolve();
	}
	pendingRawStdoutWrites++;
	const write = rawStdoutWriteTail
		.then(() => writeRawStdoutChunk(text))
		.finally(() => {
			pendingRawStdoutWrites--;
		});
	rawStdoutWriteTail = write.catch((error: unknown) => {
		rawStdoutFailed = true;
		throw error;
	});
	// The caller handles the tail it is given; the same promise must not also count as an unhandled rejection.
	void rawStdoutWriteTail.catch(() => {});
	return rawStdoutWriteTail;
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		try {
			await tail;
		} catch (error) {
			if (!rawStdoutFailureHandler) throw error;
			return;
		}
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	if (rawStdoutFailed && rawStdoutFailureHandler) return;
	try {
		await writeRawStdoutChunk("");
	} catch (error) {
		if (!rawStdoutFailureHandler) throw error;
		rawStdoutFailureHandler(error as Error);
	}
}

const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

/**
 * Sends `console.log/info/debug/warn/error` to `sink` while `isScreenOwned()` is true, so a stray line cannot land in
 * the middle of a fullscreen frame; at any other moment (the terminal stopped for a suspend, a crash report or the exit)
 * the call reaches the real console. Returns the function that puts the real methods back.
 */
export function captureConsole(
	sink: (level: ConsoleMethod, text: string) => void,
	isScreenOwned: () => boolean,
): () => void {
	const original = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;
	const installed = {} as Record<ConsoleMethod, (...args: unknown[]) => void>;
	for (const level of CONSOLE_METHODS) {
		const real = console[level].bind(console) as (...args: unknown[]) => void;
		original[level] = console[level];
		installed[level] = (...args: unknown[]) => {
			if (isScreenOwned()) sink(level, formatWithOptions({ colors: false }, ...args));
			else real(...args);
		};
		console[level] = installed[level];
	}
	return () => {
		for (const level of CONSOLE_METHODS) {
			if (console[level] === installed[level]) console[level] = original[level];
		}
	};
}
