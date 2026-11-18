import { cutText } from "@octocodeai/octocode-common/text";
import { visibleControls } from "@octocodeai/octocode-common/sanitize";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import { renderPrompt } from "../../core/prompt-template.ts";
import { ApiClient } from "../api/client.ts";
import type { InstanceRecord } from "../api/registry.ts";
import { processAlive } from "../shared/process.ts";

/** A message another session accepted into its queue (not into a turn): it lives only in that process until its model reads it. */
interface QueuedMessage {
	name: string;
	text: string;
	target: Pick<InstanceRecord, "pid" | "socket" | "http">;
}

type Target = QueuedMessage["target"];

/** What the receiver's `status` says of its queue: still `queued`, all `read`, or `gone` (nothing accepts its connection). */
type QueueState = "queued" | "read" | "gone";

/** What the watch reads of the world; a test passes its own. */
export interface ReadWatchPorts {
	now(): number;
	alive(pid: number): boolean;
	queueState(target: Target, timeoutMs: number, signal: AbortSignal): Promise<QueueState>;
}

const TIMING = {
	/** How often each receiver's pid is checked: a notice comes within about this long after the receiver exits. */
	tickMs: 1_000,
	/** How long one `status` call may take. */
	statusMs: 2_000,
	/** The first `status` after a message is tracked; each answer that it is still queued doubles the wait, up to `lastStatusMs`. */
	firstStatusMs: 2_000,
	lastStatusMs: 30_000,
	/** A receiver that keeps a message queued this long stops being watched for it: its model is busy, not gone. */
	maxWatchMs: 15 * 60_000,
};

interface Watched extends QueuedMessage {
	since: number;
	seq: number;
}

interface Receiver {
	target: Target;
	messages: Watched[];
	/** The wait before the next `status` call, and when it is due. */
	delayMs: number;
	dueAt: number;
	asking: boolean;
}

/**
 * Tells the sender, once and without waking it, when a session that accepted its message into a queue exits before
 * its model reads it: such a message exists only in the receiver's memory, so nobody else could tell. Every tick checks
 * each receiver's pid locally; a gone pid is a lost queue at once. The receiver's `status` (which it records as a read
 * of its session) is asked only on a backoff: nothing pending means everything it queued was read, and a socket nothing
 * listens on means it is gone even while its pid lives. The timer runs only while a receiver is watched.
 */
export class ReadWatch {
	private readonly receivers = new Map<string, Receiver>();
	private timer: NodeJS.Timeout | undefined;
	private lifetime = new AbortController();
	private seq = 0;
	private readonly tell: (text: string) => void;
	private readonly ports: ReadWatchPorts;

	constructor(tell: (text: string) => void, ports: Partial<ReadWatchPorts> = {}) {
		this.tell = tell;
		this.ports = { now: () => Date.now(), alive: processAlive, queueState, ...ports };
	}

	/** Watches `message` until its receiver reads its queue or exits. A new message asks its receiver again soon. */
	track(message: QueuedMessage): void {
		const now = this.ports.now();
		const key = receiverKey(message.target);
		const receiver = this.receivers.get(key) ?? {
			target: message.target,
			messages: [],
			delayMs: TIMING.firstStatusMs,
			dueAt: 0,
			asking: false,
		};
		receiver.messages.push({ ...message, since: now, seq: ++this.seq });
		receiver.delayMs = TIMING.firstStatusMs;
		receiver.dueAt = now + receiver.delayMs;
		this.receivers.set(key, receiver);
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), TIMING.tickMs);
		this.timer.unref();
	}

	/** The session ended: nobody is left to tell, and a `status` call in flight is abandoned. */
	stop(): void {
		this.receivers.clear();
		this.idle();
		this.lifetime.abort();
		this.lifetime = new AbortController();
	}

	private tick(): void {
		const now = this.ports.now();
		for (const [key, receiver] of this.receivers) {
			if (!this.ports.alive(receiver.target.pid)) {
				this.lost(key, receiver);
				continue;
			}
			receiver.messages = receiver.messages.filter((message) => now - message.since < TIMING.maxWatchMs);
			if (receiver.messages.length === 0) this.receivers.delete(key);
			else if (!receiver.asking && now >= receiver.dueAt) this.ask(key, receiver);
		}
		if (this.receivers.size === 0) this.idle();
	}

	private ask(key: string, receiver: Receiver): void {
		receiver.asking = true;
		// Only the messages tracked before the call count as read by its answer.
		const upTo = this.seq;
		const { signal } = this.lifetime;
		void this.ports
			.queueState(receiver.target, TIMING.statusMs, signal)
			.then((state) => {
				receiver.asking = false;
				if (signal.aborted || this.receivers.get(key) !== receiver) return;
				if (state === "gone") return this.lost(key, receiver);
				if (state === "read") receiver.messages = receiver.messages.filter((message) => message.seq > upTo);
				if (receiver.messages.length === 0) {
					this.receivers.delete(key);
					if (this.receivers.size === 0) this.idle();
					return;
				}
				// A message tracked meanwhile set its own, earlier due time; otherwise wait longer before asking again.
				if (receiver.messages.some((message) => message.seq > upTo)) return;
				receiver.delayMs = Math.min(receiver.delayMs * 2, TIMING.lastStatusMs);
				receiver.dueAt = this.ports.now() + receiver.delayMs;
			})
			// Only a broken notice (its template or the session's sink) gets here: stop watching and say so, rather than retry it.
			.catch((error: unknown) => {
				this.receivers.clear();
				this.idle();
				process.emitWarning(errorMessage(error), "OctocodeReadWatch");
			});
	}

	private lost(key: string, receiver: Receiver): void {
		this.receivers.delete(key);
		this.tell(receiver.messages.map(unreadNotice).join("\n\n"));
	}

	private idle(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}
}

const receiverKey = (target: Target): string => `${target.pid} ${target.socket ?? target.http?.url ?? ""}`;

/** Any failure other than an unreachable socket (a slow or overloaded receiver) counts as still queued, so it is asked again. */
async function queueState(target: Target, timeoutMs: number, signal: AbortSignal): Promise<QueueState> {
	try {
		const status = await new ApiClient(target).call<{ pending?: unknown }>("status", {}, { timeoutMs, signal });
		return status.pending === false ? "read" : "queued";
	} catch (error) {
		return isRecord(error) && error.execution === "not-sent" && error.reason === "unreachable" ? "gone" : "queued";
	}
}

/** The dead-letter notice for a socket message: what was lost, to whom, and what to do next. */
function unreadNotice(message: Watched): string {
	const lost = renderPrompt("notices/mail/dead-letter-peer.md", { who: message.name });
	const began = renderPrompt("notices/mail/dead-letter-began.md", {
		text: cutText(message.text.split("\n")[0], 120, { chars: true }),
	});
	// A peer session's next step, from the same template team mail's dead letters use.
	const next = renderPrompt("notices/mail/dead-letter-next.md", { who: message.name, child: false, reported: false });
	return visibleControls(`${lost} ${began} ${next}`);
}
