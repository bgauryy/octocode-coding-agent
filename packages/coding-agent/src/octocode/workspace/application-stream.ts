import type { ApplicationConnection, ApplicationFrame } from "@octocodeai/octocode-contracts";
import { WebSocket } from "ws";
import { redactData } from "../../../../common/src/sanitize.ts";

/** A view-only tab sees the session as it is but can do nothing: its snapshots carry no capabilities, so the page draws no controls. */
function viewFrame(frame: ApplicationFrame): ApplicationFrame {
	return frame.type === "snapshot" ? { ...frame, snapshot: { ...frame.snapshot, capabilities: [] } } : frame;
}

/** Streamed text reaches a browser at most this often per message (about 20 updates a second). */
const DELTA_WINDOW_MS = 50;

/**
 * Sends an application connection's frames to a browser socket, redacted, with streamed text coalesced to one update
 * per window. A slow socket or a resync closes it so the page reconnects and resynchronizes. Closes `connection` when
 * the stream or the socket ends. Shared by the per-session server and the user-level daemon.
 */
export async function pumpApplicationFrames(
	socket: WebSocket,
	connection: ApplicationConnection,
	options: { access?: "control" | "view" } = {},
): Promise<void> {
	const shape = options.access === "view" ? viewFrame : (frame: ApplicationFrame) => frame;
	const send = (frame: ApplicationFrame) => {
		if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "application", data: shape(frame) }));
	};
	// A delta frame carries the whole redacted text (redacting a fragment could miss a secret split across tokens), so
	// only the latest per window matters: the first goes out at once, later ones in the window collapse into one.
	let pendingDelta: ApplicationFrame | undefined;
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
		for await (const frame of connection) {
			if (socket.readyState !== WebSocket.OPEN) break;
			if (socket.bufferedAmount > 1048576) {
				socket.close(1013, "Reconnect to synchronize");
				break;
			}
			const safe = redactData(frame);
			if (safe.type === "event" && safe.event.type === "message.delta" && safe.event.text !== undefined) {
				safe.event.delta = "";
				const previous =
					pendingDelta?.type === "event" && pendingDelta.event.type === "message.delta"
						? pendingDelta.event.messageId
						: undefined;
				if (previous !== undefined && previous !== safe.event.messageId) flushDelta();
				if (deltaWindow) {
					if (pendingDelta?.type === "event")
						safe.fromSequence = pendingDelta.fromSequence ?? pendingDelta.cursor.sequence;
					pendingDelta = safe;
					continue;
				}
				send(safe);
				deltaWindow = setTimeout(tick, DELTA_WINDOW_MS);
				continue;
			}
			// Anything else keeps its order behind the text streamed so far.
			flushDelta();
			send(safe);
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
