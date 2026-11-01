import {
	APPLICATION_PROTOCOL_VERSION,
	type ApplicationCursor,
	type ApplicationFrame,
} from "@octocodeai/octocode-contracts";
import { redactData } from "../../../../../common/src/sanitize.ts";

export type ApplicationFramePayload =
	| Omit<Extract<ApplicationFrame, { type: "snapshot" }>, "protocolVersion" | "cursor" | "at">
	| Omit<Extract<ApplicationFrame, { type: "event" }>, "protocolVersion" | "cursor" | "at">
	| { type: "resumed" }
	| { type: "resync"; reason: "overflow" | "session-changed" };

/** The JSON of each frame this module created: encoded once, shared by the replay buffer, queues and sockets. */
const encoded = new WeakMap<ApplicationFrame, string>();

/**
 * A frame from a payload the wire layer already redacted (`ApplicationWire`), encoded once. Frames are immutable once
 * created: derive a new one rather than changing it.
 */
export function createApplicationFrame(cursor: ApplicationCursor, payload: ApplicationFramePayload): ApplicationFrame {
	const frame = {
		protocolVersion: APPLICATION_PROTOCOL_VERSION,
		cursor,
		at: Date.now(),
		...payload,
	} as ApplicationFrame;
	encoded.set(frame, JSON.stringify(frame));
	return frame;
}

/**
 * The JSON of a frame, redacted. A frame this process created is redacted and encoded already; any other (one relayed
 * from another process) is redacted here.
 */
export function encodeApplicationFrame(frame: ApplicationFrame): string {
	return encoded.get(frame) ?? JSON.stringify(redactData(frame));
}

/** Whether `frame` was created, redacted, by this process. */
export function isEncodedApplicationFrame(frame: ApplicationFrame): boolean {
	return encoded.has(frame);
}

/** Event frames kept for reconnecting views: at most 200 within 256 KB, measured by their encoded length. */
export class ReplayBuffer {
	frames: ApplicationFrame[] = [];
	private sizes: number[] = [];
	private chars = 0;

	push(frame: ApplicationFrame): void {
		const size = encodeApplicationFrame(frame).length;
		this.frames.push(frame);
		this.sizes.push(size);
		this.chars += size;
		// The length the encoded array would have: the frames, their commas and the brackets.
		while (this.frames.length > 200 || 2 + this.chars + Math.max(this.frames.length - 1, 0) > 262144) {
			this.frames.shift();
			this.chars -= this.sizes.shift()!;
		}
	}

	clear(): void {
		this.frames = [];
		this.sizes = [];
		this.chars = 0;
	}
}

/**
 * The frame queue of one connection. A full queue is replaced by one resync frame and drops frames until the next
 * resync; `onClose` runs first when the connection closes.
 */
export function createFrameQueue(
	overflowFrame: () => ApplicationFrame,
	onClose: () => void,
): {
	push: (frame: ApplicationFrame) => void;
	close: () => void;
	isClosed: () => boolean;
	iterator: AsyncIterator<ApplicationFrame>;
} {
	let closed = false;
	let overflowed = false;
	let queue: { frame: ApplicationFrame; size: number }[] = [];
	let bytes = 0;
	let waiting: ((result: IteratorResult<ApplicationFrame>) => void) | undefined;
	const push = (frame: ApplicationFrame) => {
		if (closed) return;
		if (frame.type === "resync") {
			queue = [];
			bytes = 0;
			overflowed = false;
		}
		if (overflowed) return;
		if (waiting) {
			const resolve = waiting;
			waiting = undefined;
			resolve({ value: frame, done: false });
			return;
		}
		const size = encodeApplicationFrame(frame).length;
		if (queue.length >= 200 || bytes + size > 262144) {
			overflowed = true;
			const resync = overflowFrame();
			queue = [{ frame: resync, size: encodeApplicationFrame(resync).length }];
			bytes = queue[0].size;
			return;
		}
		queue.push({ frame, size });
		bytes += size;
	};
	const close = () => {
		onClose();
		closed = true;
		queue = [];
		waiting?.({ value: undefined, done: true });
		waiting = undefined;
	};
	const iterator: AsyncIterator<ApplicationFrame> = {
		next: () => {
			const entry = queue.shift();
			if (entry) {
				bytes -= entry.size;
				return Promise.resolve({ value: entry.frame, done: false });
			}
			if (closed) return Promise.resolve({ value: undefined, done: true });
			if (waiting) return Promise.reject(new Error("Concurrent stream reads are unsupported"));
			return new Promise((resolve) => {
				waiting = resolve;
			});
		},
		return: async () => {
			close();
			return { value: undefined, done: true };
		},
	};
	return { push, close, isClosed: () => closed, iterator };
}
