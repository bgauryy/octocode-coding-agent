import { fstatSync, read } from "node:fs";
import { Readable } from "node:stream";

/** How long the named-pipe reader waits before it reads again when no command is waiting. */
const FIFO_POLL_MS = 50;

/**
 * Whether `fd` is a named pipe (a FIFO with a file system name, as `mkfifo` makes) on macOS. There, Node's stdin stream
 * never sees the end of a named pipe whose writer closed, so the process would wait for a command forever; anonymous
 * pipes (link count 0) and other platforms are not affected. A closed `fd` has nothing to read and is not one.
 */
export function isMacosNamedPipe(fd: number, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "darwin") return false;
	try {
		const stat = fstatSync(fd);
		return stat.isFIFO() && stat.nlink > 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EBADF") return false;
		throw error;
	}
}

/**
 * Reads `fd` with plain reads, which return 0 at the end of the pipe. A non-blocking `fd` that has nothing yet answers
 * EAGAIN, and the reader tries again after `pollMs`; a blocking one waits in the read. `destroy()` stops it.
 */
export function pipeReader(fd: number, pollMs = FIFO_POLL_MS): Readable {
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let retry: NodeJS.Timeout | undefined;
	const pull = () => {
		retry = undefined;
		read(fd, buffer, 0, buffer.length, null, (error, bytes) => {
			if (stream.destroyed) return;
			if (error?.code === "EAGAIN") retry = setTimeout(pull, pollMs);
			else if (error) stream.destroy(error);
			else stream.push(bytes === 0 ? null : Buffer.from(buffer.subarray(0, bytes)));
		});
	};
	const stream = new Readable({
		read: pull,
		destroy(error, callback) {
			clearTimeout(retry);
			callback(error);
		},
	});
	return stream;
}

/** The command input of RPC mode and how to stop reading it at shutdown. */
export interface RpcInput {
	stream: Readable;
	close(): void;
}

/**
 * RPC mode's command input: stdin, or on macOS a direct reader of a named pipe on fd 0, so closing the pipe's writer ends
 * the process as it does with an anonymous pipe. Opening `process.stdin` first makes fd 0 non-blocking, so the direct
 * reader polls instead of holding a thread-pool thread in a read; the stdin stream itself stays paused.
 */
export function rpcInput(): RpcInput {
	if (!isMacosNamedPipe(0)) return { stream: process.stdin, close: () => process.stdin.pause() };
	process.stdin.pause();
	const stream = pipeReader(0);
	return { stream, close: () => stream.destroy() };
}
