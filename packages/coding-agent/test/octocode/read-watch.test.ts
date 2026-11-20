import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadWatch, type ReadWatchPorts } from "../../src/octocode/external/read-watch.ts";

/**
 * A sender watches the messages another session queued until that session reads them or exits. It checks the
 * receiver's pid locally every second and asks the receiver's `status` (a read the receiver records in its session)
 * only on a backoff, so a busy receiver is not flooded with recorded reads.
 */

const target = { pid: 4242, socket: "/tmp/peer.sock" };
const MINUTE = 60_000;

function watch(state: "queued" | "read" = "queued") {
	let alive = true;
	let answer = state;
	const queueState = vi.fn<ReadWatchPorts["queueState"]>(async () => answer);
	const tell = vi.fn<(text: string) => void>();
	const readWatch = new ReadWatch(tell, { alive: () => alive, queueState });
	return {
		readWatch,
		tell,
		queueState,
		kill: () => (alive = false),
		answer: (next: "queued" | "read") => (answer = next),
		send: (text: string) => readWatch.track({ name: "octocode-agent-main-peer", text, target }),
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a sender watching a message another session queued", () => {
	it("asks a live, busy receiver a few dozen times over 15 minutes, then stops watching", async () => {
		const w = watch();
		w.send("still queued");
		await vi.advanceTimersByTimeAsync(15 * MINUTE);
		const asked = w.queueState.mock.calls.length;
		// Once a second would be 900 recorded reads in the receiver's session.
		expect(asked).toBeGreaterThan(0);
		expect(asked).toBeLessThanOrEqual(40);
		await vi.advanceTimersByTimeAsync(10 * MINUTE);
		expect(w.queueState.mock.calls.length).toBe(asked);
		expect(vi.getTimerCount()).toBe(0);
		expect(w.tell).not.toHaveBeenCalled();
	});

	it("tells the sender within about two seconds of the receiver exiting, even deep into the backoff", async () => {
		const w = watch();
		w.send("never read");
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		const asked = w.queueState.mock.calls.length;
		w.kill();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(w.tell).toHaveBeenCalledTimes(1);
		expect(w.tell.mock.calls[0][0]).toContain("octocode-agent-main-peer");
		expect(w.tell.mock.calls[0][0]).toContain("never read");
		// The exit is seen from the pid alone.
		expect(w.queueState.mock.calls.length).toBe(asked);
		await vi.advanceTimersByTimeAsync(MINUTE);
		expect(w.tell).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("asks again soon after a new message, whatever the backoff had reached", async () => {
		const w = watch();
		w.send("first");
		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		const asked = w.queueState.mock.calls.length;
		w.send("second");
		await vi.advanceTimersByTimeAsync(3_000);
		expect(w.queueState.mock.calls.length).toBe(asked + 1);
	});

	it("stays silent about messages the receiver read before it exited", async () => {
		const w = watch();
		w.send("read in time");
		w.answer("read");
		await vi.advanceTimersByTimeAsync(3_000);
		w.kill();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(w.tell).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports only the messages still unread when the receiver exits", async () => {
		const w = watch("read");
		w.send("read first");
		await vi.advanceTimersByTimeAsync(3_000);
		w.answer("queued");
		w.send("queued later");
		await vi.advanceTimersByTimeAsync(3_000);
		w.kill();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(w.tell).toHaveBeenCalledTimes(1);
		expect(w.tell.mock.calls[0][0]).toContain("queued later");
		expect(w.tell.mock.calls[0][0]).not.toContain("read first");
	});

	it("stops on reset: no timer, no notice", async () => {
		const w = watch();
		w.send("abandoned");
		w.readWatch.stop();
		w.kill();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(vi.getTimerCount()).toBe(0);
		expect(w.tell).not.toHaveBeenCalled();
	});
});
