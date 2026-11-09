import { randomUUID } from "node:crypto";
import type {
	ApplicationCursor,
	ApplicationEvent,
	ApplicationFrame,
	ApplicationSnapshot,
} from "@octocodeai/octocode-contracts";
import { createApplicationFrame, createFrameQueue, type ApplicationFramePayload, type ReplayBuffer } from "./frames.ts";
import { ApplicationWire, type StreamHint } from "./wire.ts";

/** The frames one application service broadcasts: cursor (epoch and sequence), the replay buffer it fills, wire encoding and connected sinks. */
export class ApplicationFrameStream {
	private epoch = randomUUID();
	private sequence = 0;
	private readonly sinks = new Set<(frame: ApplicationFrame) => void>();
	private readonly closes = new Set<() => void>();
	private readonly wire = new ApplicationWire();

	private readonly sessionId: () => string;
	private readonly replay: ReplayBuffer;

	constructor(sessionId: () => string, replay: ReplayBuffer) {
		this.sessionId = sessionId;
		this.replay = replay;
	}

	private cursor(): ApplicationCursor {
		return { sessionId: this.sessionId(), epoch: this.epoch, sequence: this.sequence };
	}

	frame(payload: ApplicationFramePayload): ApplicationFrame {
		return createApplicationFrame(this.cursor(), payload);
	}

	/** Start a new epoch: connected views must resync. `clearWire` also forgets the wire encoder's streamed state. */
	restart(clearWire: boolean): void {
		this.epoch = randomUUID();
		this.sequence = 0;
		this.replay.clear();
		if (clearWire) this.wire.clear();
	}

	resync(reason: "overflow" | "session-changed"): void {
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(this.frame({ type: "resync", reason }));
	}

	// A streamed delta that releases nothing yet becomes no frame and uses no sequence.
	emit(event: ApplicationEvent, hint?: StreamHint): void {
		const wired = this.wire.event(event, hint);
		if (!wired) return;
		this.sequence++;
		const frame = this.frame({ type: "event", event: wired });
		this.replay.push(frame);
		// oxlint-disable-next-line unicorn/no-useless-spread -- snapshot so sinks added during dispatch do not receive this frame
		for (const sink of [...this.sinks]) sink(frame);
	}

	/** A queue that starts with a resume from `cursor` when the replay buffer still covers it, else with `snapshot`. */
	connect(cursor: ApplicationCursor | undefined, snapshot: () => ApplicationSnapshot) {
		const connection = createFrameQueue(
			() => this.frame({ type: "resync", reason: "overflow" }),
			() => {
				this.closes.delete(connection.close);
				this.sinks.delete(connection.push);
			},
		);
		const { push, close } = connection;
		if (
			cursor &&
			cursor.sessionId === this.sessionId() &&
			cursor.epoch === this.epoch &&
			cursor.sequence <= this.sequence &&
			cursor.sequence >= (this.replay.frames[0]?.cursor.sequence ?? this.sequence + 1) - 1
		) {
			push({ ...this.frame({ type: "resumed" }), cursor: { ...cursor } });
			for (const frame of this.replay.frames) if (frame.cursor.sequence > cursor.sequence) push(frame);
		} else push(this.frame({ type: "snapshot", snapshot: this.wire.snapshot(snapshot()) }));
		this.sinks.add(push);
		this.closes.add(close);
		return connection;
	}

	closeConnections(): void {
		for (const close of this.closes) close();
	}

	clear(): void {
		this.sinks.clear();
		this.replay.clear();
		this.wire.clear();
	}
}
