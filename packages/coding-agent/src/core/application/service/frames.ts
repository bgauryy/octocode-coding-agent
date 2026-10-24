import {
	APPLICATION_PROTOCOL_VERSION,
	type ApplicationCursor,
	type ApplicationFrame,
} from "@octocodeai/octocode-contacts";
import { redactData } from "../../../octocode/shared/sanitize.ts";

export type ApplicationFramePayload =
	| Omit<Extract<ApplicationFrame, { type: "snapshot" }>, "protocolVersion" | "cursor" | "at">
	| Omit<Extract<ApplicationFrame, { type: "event" }>, "protocolVersion" | "cursor" | "at">
	| { type: "resumed" }
	| { type: "resync"; reason: "overflow" | "session-changed" };

/** Serialized views retain rich fields without exporting credentials from native transcript data. */
export function createApplicationFrame(cursor: ApplicationCursor, payload: ApplicationFramePayload): ApplicationFrame {
	return redactData({ protocolVersion: APPLICATION_PROTOCOL_VERSION, cursor, at: Date.now(), ...payload });
}

/**
 * Append an event frame to the replay buffer, then drop the oldest frames until at most 200 remain within 256 KB.
 * `sizes` holds the serialized length of each replay frame, so bounding the buffer does not reserialize it on every
 * token. Returns the new serialized total.
 */
export function appendReplayFrame(
	replay: ApplicationFrame[],
	sizes: number[],
	chars: number,
	frame: ApplicationFrame,
): number {
	const size = JSON.stringify(frame).length;
	replay.push(frame);
	sizes.push(size);
	chars += size;
	// The length `JSON.stringify(replay)` would have: the frames, their commas and the brackets.
	while (replay.length > 200 || 2 + chars + Math.max(replay.length - 1, 0) > 262144) {
		replay.shift();
		chars -= sizes.shift()!;
	}
	return chars;
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
	let queue: ApplicationFrame[] = [];
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
		const size = JSON.stringify(frame).length;
		if (queue.length >= 200 || bytes + size > 262144) {
			overflowed = true;
			queue = [overflowFrame()];
			bytes = JSON.stringify(queue[0]).length;
			return;
		}
		queue.push(frame);
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
			const frame = queue.shift();
			if (frame) {
				bytes -= JSON.stringify(frame).length;
				return Promise.resolve({ value: frame, done: false });
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
