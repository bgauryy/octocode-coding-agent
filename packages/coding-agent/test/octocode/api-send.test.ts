import { describe, expect, it, vi } from "vitest";
import { sendMessage } from "../../src/octocode/api/bridge/send.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { ERR, PREPARING, SEND_ACK_MS } from "../../src/octocode/api/protocol.ts";
import { SendReceipts } from "../../src/octocode/api/receipts.ts";
import { asSetup } from "./fake-host.ts";

function setup() {
	let sessionId = "s1";
	let resolveSend!: () => void;
	let rejectSend!: (error: Error) => void;
	const sending = new Promise<void>((resolve, reject) => {
		resolveSend = resolve;
		rejectSend = reject;
	});
	const send = vi.fn(() => sending);
	const receipts = new SendReceipts();
	receipts.follow("s1");
	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
	const host = {
		api: asSetup({ sendMessage: send }),
		agents: { list: () => [], deliverable: (text: string) => text },
		operations: {},
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
		replaceSession: () => {
			sessionId = "s2";
			receipts.follow(sessionId);
		},
	};
}

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
		await Promise.resolve();
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
		await Promise.resolve();
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
		await Promise.resolve();
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
