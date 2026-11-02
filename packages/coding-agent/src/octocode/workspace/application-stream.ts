import type { ApplicationConnection, ApplicationFrame } from "@octocodeai/octocode-contracts";
import { WebSocket } from "ws";
import { redactData } from "../../../../common/src/sanitize.ts";
import { encodeApplicationFrame, isEncodedApplicationFrame } from "../../core/application/service/frames.ts";
import { readerStalled } from "./socket-pressure.ts";

/** A view-only tab sees the session as it is but can do nothing: its snapshots carry no capabilities, so the page draws no controls. */
function viewFrame(frame: ApplicationFrame): ApplicationFrame {
	return frame.type === "snapshot" ? { ...frame, snapshot: { ...frame.snapshot, capabilities: [] } } : frame;
}

/** Streamed text reaches a browser at most this often per message (about 20 updates a second). */
const DELTA_WINDOW_MS = 50;

type EventFrame = Extract<ApplicationFrame, { type: "event" }>;
type DeltaFrame = EventFrame & { event: Extract<EventFrame["event"], { type: "message.delta" }> };
const isDelta = (frame: ApplicationFrame | undefined): frame is DeltaFrame =>
	frame?.type === "event" && frame.event.type === "message.delta";

/**
 * Joins a delta to the one pending in the window. Appends to the same block join into one append; a full update
 * replaces whatever of its message is pending. Undefined when they cannot join.
 */
function joinDelta(pending: DeltaFrame, next: DeltaFrame): DeltaFrame | undefined {
	if (pending.event.messageId !== next.event.messageId) return undefined;
	const fromSequence = pending.fromSequence ?? pending.cursor.sequence;
	if (!next.event.block) return { ...next, fromSequence };
	if (!pending.event.block || pending.event.block.index !== next.event.block.index) return undefined;
	const full = next.event.block.full ?? pending.event.block.full;
	return {
		...next,
		fromSequence,
		event: {
			...next.event,
			delta: pending.event.delta + next.event.delta,
			block: { ...pending.event.block, ...(full ? { full } : {}) },
		},
	};
}

/**
 * Sends an application connection's frames to a browser socket, redacted, with streamed text coalesced to one update
 * per window. A page that stopped reading (`readerStalled`) or a resync closes it so the page reconnects and resynchronizes. Closes `connection` when
 * the stream or the socket ends. Shared by the per-session server and the user-level daemon.
 */
export async function pumpApplicationFrames(
	socket: WebSocket,
	connection: ApplicationConnection,
	options: { access?: "control" | "view" } = {},
): Promise<void> {
	const view = options.access === "view";
	// Frames this process created are redacted and encoded once; relayed ones were redacted by their session and are
	// redacted again here, once, before anything else reads them.
	const joined = new WeakSet<ApplicationFrame>();
	const send = (frame: ApplicationFrame) => {
		if (socket.readyState !== WebSocket.OPEN) return;
		const data =
			(view && frame.type === "snapshot") || joined.has(frame)
				? JSON.stringify(view ? viewFrame(frame) : frame)
				: encodeApplicationFrame(frame);
		socket.send(`{"type":"application","data":${data}}`);
	};
	// Only the joined deltas of a window matter: the first goes out at once, later ones in the window join into one.
	let pendingDelta: DeltaFrame | undefined;
	let deltaWindow: ReturnType<typeof setTimeout> | undefined;
	const flushDelta = () => {
		const frame = pendingDelta;
		pendingDelta = undefined;
		if (frame) send(frame);
	};
	const tick = () => {
		deltaWindow = undefined;
		if (!pendingDelta) return;
		flushDelta();
		deltaWindow = setTimeout(tick, DELTA_WINDOW_MS);
	};
	try {
		for await (const received of connection) {
			if (socket.readyState !== WebSocket.OPEN) break;
			if (readerStalled(socket)) {
				socket.close(1013, "Reconnect to synchronize");
				break;
			}
			const frame = isEncodedApplicationFrame(received) ? received : redactData(received);
			if (isDelta(frame)) {
				if (!deltaWindow) {
					send(frame);
					deltaWindow = setTimeout(tick, DELTA_WINDOW_MS);
					continue;
				}
				const next = pendingDelta && joinDelta(pendingDelta, frame);
				if (next) joined.add(next);
				else flushDelta();
				pendingDelta = next ?? frame;
				continue;
			}
			// Anything else keeps its order behind the text streamed so far.
			flushDelta();
			send(frame);
			if (frame.type === "resync") {
				socket.close(1013, "Reconnect to synchronize");
				break;
			}
		}
		flushDelta();
	} catch {
		socket.close(1011, "Reopen the workspace");
	} finally {
		clearTimeout(deltaWindow);
		connection.close();
	}
}
