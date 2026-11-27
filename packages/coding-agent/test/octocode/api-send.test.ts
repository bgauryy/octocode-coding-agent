import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { sendMessage } from "../../src/octocode/api/bridge/send.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { ERR, PREPARING, SEND_ACK_MS } from "../../src/octocode/api/protocol.ts";
import { apiReceipts, openDatabase } from "../../../db/src/api.ts";
import { SendReceipts, type ReceiptStore } from "../../src/octocode/api/receipts.ts";
import { asSetup } from "./fake-host.ts";

function setup(store?: ReceiptStore, operations: object = {}) {
	let sessionId = "s1";
	let resolveSend!: () => void;
	let rejectSend!: (error: Error) => void;
	const sending = new Promise<void>((resolve, reject) => {
		resolveSend = resolve;
		rejectSend = reject;
	});
	const send = vi.fn((_message: unknown, _options: unknown) => sending);
	const receipts = new SendReceipts(store);
	receipts.follow("s1");
	let idle = true;
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => idle,
		hasPendingMessages: () => false,
	};
	const host = {
		api: asSetup({ sendMessage: send }),
		agents: { list: () => [], deliverable: (text: string) => text },
		operations,
		receipts,
		log: new EventLog(),
		session: () => ctx,
		guardSession: () => undefined,
		nextId: () => "x1",
		audit: () => undefined,
	} as unknown as Parameters<typeof sendMessage>[0];
	return {
		host,
		receipts,
		send,
		resolveSend,
		rejectSend,
		setIdle: (value: boolean) => {
			idle = value;
		},
		replaceSession: () => {
			sessionId = "s2";
			receipts.follow(sessionId);
		},
	};
}

/** Lets every handler of an already settled promise run: a late one sits several microtasks behind the rejection. */
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("API message.send asynchronous handoff", () => {
	it("returns promptly without wait, then retains an uncertain keyed rejection instead of dispatching a retry", async () => {
		const { host, receipts, send, rejectSend } = setup();
		const params = { text: "hello", key: "once" };
		await expect(sendMessage(host, params)).resolves.toEqual({ id: "x1", queued: "turn" });
		expect(send).toHaveBeenCalledTimes(1);
		rejectSend(new Error("host rejected"));
		await vi.waitFor(() => expect(receipts.get("once")?.phase).toBe("uncertain"));
		expect(receipts.busy).toBe(false);
		expect(receipts.activeKey).toBeUndefined();
		await expect(sendMessage(host, params)).rejects.toMatchObject({
			code: ERR.unavailable,
			data: { execution: "uncertain", id: "x1" },
		});
		expect(send).toHaveBeenCalledTimes(1);
		await expect(sendMessage(host, { text: "another", key: "new", requireIdle: true })).resolves.toEqual({
			id: "x1",
			queued: "turn",
		});
		expect(send).toHaveBeenCalledTimes(2);
	});

	it.each([undefined, "once"])("ends a waiting request when the asynchronous handoff rejects (key=%s)", async (key) => {
		const { host, rejectSend } = setup();
		const waiting = sendMessage(host, { text: "hello", key, wait: true, timeoutMs: 1_000 });
		rejectSend(new Error("host rejected"));
		await expect(waiting).rejects.toMatchObject({ code: ERR.unavailable, data: { execution: "uncertain" } });
	});

	it("ignores a late rejection after the session is replaced", async () => {
		const { host, receipts, rejectSend, replaceSession } = setup();
		await sendMessage(host, { text: "hello", key: "old" });
		const seq = host.log.seq;
		replaceSession();
		rejectSend(new Error("old host rejected"));
		await settled();
		expect(host.log.seq).toBe(seq);
		expect(receipts.get("old")).toBeUndefined();
		expect(receipts.busy).toBe(false);
	});

	it("keeps a settled receipt when an obsolete send promise rejects later", async () => {
		const { host, receipts, send, rejectSend } = setup();
		const params = { text: "hello", key: "once" };
		await sendMessage(host, params);
		receipts.settle({ text: "finished" });
		rejectSend(new Error("late host error"));
		await settled();
		expect(receipts.get("once")?.phase).toBe("settled");
		await expect(sendMessage(host, { ...params, wait: true })).resolves.toEqual({
			id: "x1",
			queued: "turn",
			text: "finished",
		});
		expect(send).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("does not report a late rejection after an unkeyed send settles (wait=%s)", async (wait) => {
		const { host, receipts, rejectSend } = setup();
		const result = sendMessage(host, { text: "hello", wait });
		if (!wait) await result;
		const before = host.log.seq;
		receipts.settle({ text: "finished" });
		if (wait) await expect(result).resolves.toMatchObject({ id: "x1", text: "finished" });
		rejectSend(new Error("late host error"));
		await settled();
		expect(host.log.seq).toBe(before);
	});

	it("dispatches once when a same-key retry follows a delivery that outlived the sender's wait", async () => {
		vi.useFakeTimers();
		try {
			const { host, send, resolveSend } = setup();
			const params = { text: "hello", key: "sender-key", wait: true, timeoutMs: 1_000 };
			const first = sendMessage(host, params).catch((error: unknown) => error);
			await vi.advanceTimersByTimeAsync(5_000);
			await first;
			const retry = sendMessage(host, params).catch((error: unknown) => error);
			resolveSend();
			await vi.advanceTimersByTimeAsync(5_000);
			await retry;
			expect(send).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("acknowledges a keyed send whose preparation stalls, delivers it once when the stall clears, and dedupes a retry", async () => {
		vi.useFakeTimers();
		try {
			const { host, send, resolveSend } = setup();
			let release!: () => void;
			const stalled = new Promise<void>((resolve) => {
				release = resolve;
			});
			(host as unknown as { verify: (external: unknown) => Promise<unknown> }).verify = async (external) => {
				await stalled;
				return external;
			};
			const params = { text: "hello", key: "k1" };
			const first = sendMessage(host, params);
			await vi.advanceTimersByTimeAsync(SEND_ACK_MS);
			await expect(first).resolves.toEqual({ id: "x1", queued: PREPARING, key: "k1" });
			expect(send).not.toHaveBeenCalled();
			release();
			await vi.advanceTimersByTimeAsync(0);
			expect(send).toHaveBeenCalledTimes(1);
			await expect(sendMessage(host, params)).resolves.toEqual({ id: "x1", queued: "turn" });
			resolveSend();
			expect(send).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("API message.send whose preparation spans the receiver's run end", () => {
	it.each([undefined, "k1"])("delivers it as a new turn instead of refusing it (key=%s)", async (key) => {
		const { host, receipts, send, setIdle } = setup();
		setIdle(false);
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => {
			release = resolve;
		});
		(host as unknown as { verify: (external: unknown) => Promise<unknown> }).verify = async (external) => {
			await stalled;
			return external;
		};
		const sending = sendMessage(host, { text: "hello", key, wait: true, timeoutMs: 5_000 });
		await Promise.resolve();
		expect(receipts.preparingCount).toBe(1);
		setIdle(true);
		receipts.settle({ text: "the run" });
		release();
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ triggerTurn: true }));
		if (key) {
			expect(receipts.get(key)?.accepted.queued).toBe("turn");
			expect(receipts.activeKey).toBe(key);
		}
		receipts.settle({ text: "new turn" });
		await expect(sending).resolves.toMatchObject({ id: "x1", queued: "turn", text: "new turn" });
	});
});

describe("API keyed message.send across a receiver restart", () => {
	function dbStore(): { store: ReceiptStore; close(): void } {
		const dir = mkdtempSync(path.join(tmpdir(), "receipts-"));
		const agent = openDatabase({
			file: path.join(dir, "agent.db"),
			mirrorFile: path.join(dir, "transcripts.db"),
			archiveDir: path.join(dir, "archive"),
			privateParent: false,
		});
		return {
			close: () => agent.close(),
			store: {
				save: (s, k, row) => apiReceipts.save(agent.db, s, k, row, Date.now()),
				setPhase: (s, k, phase) => apiReceipts.setPhase(agent.db, s, k, phase, Date.now()),
				find: (s, k) => apiReceipts.find(agent.db, s, k),
				forget: (s, k) => apiReceipts.forget(agent.db, s, k),
			},
		};
	}

	it("sends a message that crashed in preparation when the sender retries its key, once", async () => {
		const { store, close } = dbStore();
		try {
			vi.useFakeTimers();
			const first = setup(store, { admit: () => new Promise<void>(() => undefined) });
			const acked = sendMessage(first.host, { text: "hello", key: "k", timeoutMs: 600_000 });
			await vi.advanceTimersByTimeAsync(SEND_ACK_MS + 1);
			await expect(acked).resolves.toMatchObject({ queued: PREPARING, key: "k" });
			vi.useRealTimers();
			// The receiver crashes here: a new one has no memory of the message.
			const second = setup(store);
			expect(first.send).not.toHaveBeenCalled();
			await expect(sendMessage(second.host, { text: "hello", key: "k" })).resolves.toEqual({
				id: "x1",
				queued: "turn",
			});
			expect(second.send).toHaveBeenCalledTimes(1);
			await expect(sendMessage(second.host, { text: "hello", key: "k" })).resolves.toEqual({
				id: "x1",
				queued: "turn",
			});
			expect(second.send).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
			close();
		}
	});

	it("does not send again a message an earlier receiver accepted, and refuses the key for other input", async () => {
		const { store, close } = dbStore();
		try {
			const first = setup(store);
			await sendMessage(first.host, { text: "hello", key: "k" });
			expect(first.send).toHaveBeenCalledTimes(1);
			const second = setup(store);
			await expect(sendMessage(second.host, { text: "hello", key: "k" })).resolves.toMatchObject({
				id: "x1",
				queued: "turn",
			});
			await expect(sendMessage(second.host, { text: "other", key: "k" })).rejects.toMatchObject({
				data: { execution: "not-sent" },
			});
			expect(second.send).not.toHaveBeenCalled();
		} finally {
			close();
		}
	});

	it("reports a handoff that failed after dispatch to a retry after the restart", async () => {
		const { store, close } = dbStore();
		try {
			const first = setup(store);
			await sendMessage(first.host, { text: "hello", key: "k" });
			first.rejectSend(new Error("host rejected"));
			await vi.waitFor(() => expect(first.receipts.get("k")?.phase).toBe("uncertain"));
			const second = setup(store);
			await expect(sendMessage(second.host, { text: "hello", key: "k" })).rejects.toMatchObject({
				data: { execution: "uncertain", id: "x1" },
			});
			expect(second.send).not.toHaveBeenCalled();
		} finally {
			close();
		}
	});
});
