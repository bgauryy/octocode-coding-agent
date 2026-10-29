import { describe, expect, it } from "vitest";
import { getApplicationPort, getApplicationPortForSession } from "../src/core/application/index.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
function fixture() {
	let listener: ((event: AgentSessionEvent) => void) | undefined;
	let subscriptions = 0;
	let runs = 0;
	const session = {
		sessionId: "session-A",
		messages: [],
		isStreaming: false,
		subscribe(fn: typeof listener) {
			listener = fn;
			subscriptions++;
			return () => {
				listener = undefined;
			};
		},
		async prompt() {
			runs++;
		},
		async abort() {},
	} as unknown as AgentSession;
	return {
		session,
		emit: (event: unknown) => listener?.(event as AgentSessionEvent),
		counts: () => ({ subscriptions, runs }),
	};
}
describe("application port", () => {
	it("shares one source and streams partial text identically to two views", async () => {
		const f = fixture();
		const service = getApplicationPort(f.session);
		const a = service.connect()[Symbol.asyncIterator]();
		const b = service.connect()[Symbol.asyncIterator]();
		expect((await a.next()).value.type).toBe("snapshot");
		await b.next();
		f.emit({
			type: "message_update",
			message: { role: "assistant", timestamp: 101 },
			assistantMessageEvent: {
				type: "text_delta",
				delta: "Partial",
				contentIndex: 0,
			},
		});
		expect((await a.next()).value).toEqual((await b.next()).value);
		expect(f.counts().subscriptions).toBe(1);
		service.dispose();
	});
	it("announces a message before a delta when the first engine event is an update", async () => {
		const f = fixture();
		const service = getApplicationPort(f.session);
		const live = service.connect()[Symbol.asyncIterator]();
		await live.next();
		f.emit({
			type: "message_update",
			message: { role: "assistant", timestamp: 101 },
			assistantMessageEvent: { type: "text_delta", delta: "First", contentIndex: 0 },
		});
		expect((await live.next()).value.event).toMatchObject({
			type: "message.started",
			message: { role: "assistant", text: "", complete: false },
		});
		expect((await live.next()).value.event).toMatchObject({
			type: "message.delta",
			delta: "First",
			text: "First",
		});
		service.dispose();
	});
	it("keeps the replay buffer within 256 KB of serialized frames while text streams", () => {
		const f = fixture();
		const service = getApplicationPort(f.session);
		for (let i = 0; i < 40; i++)
			f.emit({
				type: "message_update",
				message: { role: "assistant", timestamp: 101 },
				assistantMessageEvent: { type: "text_delta", delta: `${i}`.padEnd(5000, "x"), contentIndex: 0 },
			});
		const internals = service as unknown as { replay: unknown[]; replayChars: number };
		const serialized = JSON.stringify(internals.replay).length;
		expect(serialized).toBeLessThanOrEqual(262144);
		expect(internals.replayChars).toBe(
			internals.replay.reduce<number>((sum, frame) => sum + JSON.stringify(frame).length, 0),
		);
		expect(JSON.stringify(internals.replay.at(-1))).toContain('"delta":"39');
		service.dispose();
	});
	it("replays retained events and snapshots expired epochs", async () => {
		const f = fixture();
		const service = getApplicationPort(f.session);
		const c = service.connect();
		const first = (await c[Symbol.asyncIterator]().next()).value;
		c.close();
		f.emit({ type: "agent_start" });
		const replay = service.connect({ cursor: first.cursor })[Symbol.asyncIterator]();
		expect((await replay.next()).value.type).toBe("resumed");
		expect((await replay.next()).value.event.type).toBe("run.started");
		expect(
			(
				await service
					.connect({ cursor: { ...first.cursor, epoch: "old" } })
					[Symbol.asyncIterator]()
					.next()
			).value.type,
		).toBe("snapshot");
		service.dispose();
	});
	it("deduplicates requests and rejects changed payloads and stale sessions", async () => {
		const f = fixture();
		const service = getApplicationPort(f.session);
		const command = {
			id: "request-A",
			sessionId: "session-A",
			action: "prompt" as const,
			text: "hello",
		};
		await service.execute(command);
		await service.execute(command);
		expect(f.counts().runs).toBe(1);
		await expect(service.execute({ ...command, text: "changed" })).rejects.toThrow();
		await expect(service.execute({ ...command, id: "other", sessionId: "stale" })).rejects.toThrow();
		service.dispose();
	});
});

it("closing a view does not abort execution and disposal completes pending reads", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	const a = service.connect();
	const b = service.connect();
	await a[Symbol.asyncIterator]().next();
	await b[Symbol.asyncIterator]().next();
	a.close();
	const next = b[Symbol.asyncIterator]().next();
	service.dispose();
	expect((await next).done).toBe(true);
	await expect(
		service.execute({
			id: "late",
			sessionId: "session-A",
			action: "prompt",
			text: "no",
		}),
	).rejects.toThrow("closed");
	expect(f.counts().runs).toBe(0);
});
it("slow views require resync while another view keeps receiving", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	const slow = service.connect();
	await slow[Symbol.asyncIterator]().next();
	const fast = service.connect();
	await fast[Symbol.asyncIterator]().next();
	for (let i = 0; i < 205; i++) {
		service.publishDomain({ type: "session.status", status: "idle" });
		expect((await fast[Symbol.asyncIterator]().next()).value.type).toBe("event");
	}
	expect((await slow[Symbol.asyncIterator]().next()).value).toMatchObject({
		type: "resync",
		reason: "overflow",
	});
	service.dispose();
});
it("bounds live queue previews the same way as reconnect snapshots", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	const live = service.connect();
	await live[Symbol.asyncIterator]().next();
	const full = "queued text ".repeat(6000);
	f.emit({ type: "queue_update", steering: Array(5).fill(full), followUp: Array(5).fill(full) });
	const frame = (await live[Symbol.asyncIterator]().next()).value;
	expect(frame.event.type).toBe("queue.changed");
	expect(JSON.stringify(frame).length).toBeLessThan(262144);
	expect(frame.event.steering).toHaveLength(5);
	expect(frame.event.steering[0]).toContain("[Queue preview shortened]");
	const fresh = (await service.connect()[Symbol.asyncIterator]().next()).value;
	expect(frame.event.steering).toEqual(fresh.snapshot.steering);
	expect(frame.event.followUp).toEqual(fresh.snapshot.followUp);
	service.dispose();
});
it("rejects stale connection commands after switching session", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	const connection = service.connect();
	await connection[Symbol.asyncIterator]().next();
	Object.defineProperty(f.session, "sessionId", { value: "session-B" });
	f.emit({ type: "agent_start" });
	expect((await connection[Symbol.asyncIterator]().next()).value).toMatchObject({
		type: "resync",
		reason: "session-changed",
	});
	await expect(
		connection.execute({
			id: "stale",
			sessionId: "session-A",
			action: "prompt",
			text: "no",
		}),
	).rejects.toThrow("session changed");
	service.dispose();
});
it("does not dispatch an accepted abort to a newer run in the same session", async () => {
	const f = fixture();
	let aborts = 0;
	f.session.abort = async () => {
		aborts++;
	};
	const service = getApplicationPort(f.session);
	f.emit({ type: "agent_start" });
	const runId = (await service.connect()[Symbol.asyncIterator]().next()).value.snapshot.runId;
	const accepted = service.execute({ id: "abort-old", sessionId: "session-A", action: "abort", runId });
	f.emit({ type: "agent_settled", aborted: false });
	f.emit({ type: "agent_start" });
	expect((await accepted).status).toBe("accepted");
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(aborts).toBe(0);
	const snapshot = (await service.connect()[Symbol.asyncIterator]().next()).value.snapshot;
	expect(snapshot.receipts).toContainEqual(expect.objectContaining({ id: "abort-old", status: "failed" }));
	service.dispose();
});
it("bounds a command failure so the receipt does not overflow a live view", async () => {
	const f = fixture();
	f.session.prompt = async () => {
		throw new Error("failure ".repeat(40000));
	};
	const service = getApplicationPort(f.session);
	const live = service.connect()[Symbol.asyncIterator]();
	await live.next();
	await service.execute({ id: "large-error", sessionId: "session-A", action: "prompt", text: "hello" });
	expect((await live.next()).value.event.receipt.status).toBe("accepted");
	const result = (await live.next()).value;
	expect(result.event).toMatchObject({ type: "command.receipt", receipt: { id: "large-error", status: "failed" } });
	expect(result.event.receipt.message.length).toBeLessThanOrEqual(1000);
	service.dispose();
});
it("reads durable receipts without executing uncertain requests again", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	service.setReceiptStore({
		begin: (command) => ({
			fresh: false,
			receipt: { id: command.id, status: "accepted" },
		}),
		finish: () => {
			throw new Error("must not finish");
		},
	});
	expect(
		await service.execute({
			id: "persisted",
			sessionId: "session-A",
			action: "prompt",
			text: "hello",
		}),
	).toEqual({ id: "persisted", status: "accepted" });
	expect(f.counts().runs).toBe(0);
	service.dispose();
});

it("restores partial tools and compaction status on a fresh connection", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	const first = service.connect();
	await first[Symbol.asyncIterator]().next();
	f.emit({
		type: "tool_execution_start",
		toolCallId: "tool-A",
		toolName: "read",
		args: { path: "src/a.ts", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
	});
	f.emit({
		type: "tool_execution_update",
		toolCallId: "tool-A",
		toolName: "read",
		args: {},
		partialResult: { content: [{ type: "text", text: "Partial output" }] },
	});
	f.emit({ type: "compaction_start", reason: "manual" });
	first.close();
	const frame = (await service.connect()[Symbol.asyncIterator]().next()).value;
	expect(frame.snapshot.tools).toEqual([
		{
			toolCallId: "tool-A",
			order: 0,
			toolName: "read",
			text: "Partial output",
			arguments: { path: "src/a.ts", token: "[redacted]" },
			content: [{ id: "tool:tool-A:0", type: "text", text: "Partial output" }],
			status: "running",
			hint: "src/a.ts",
		},
	]);
	expect(frame.snapshot.status).toBe("compacting");
	service.dispose();
});

it("streams the same tool order later retained in a snapshot", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	const live = service.connect()[Symbol.asyncIterator]();
	await live.next();
	f.emit({
		type: "message_end",
		message: { role: "user", timestamp: 1, content: "Read the file" },
	});
	expect((await live.next()).value.event.message.order).toBe(0);
	f.emit({
		type: "tool_execution_start",
		toolCallId: "tool-A",
		toolName: "read",
		args: { path: "src/a.ts" },
	});
	expect((await live.next()).value.event).toMatchObject({
		type: "tool.started",
		toolCallId: "tool-A",
		order: 1,
	});
	const fresh = (await service.connect()[Symbol.asyncIterator]().next()).value;
	expect(fresh.snapshot.tools[0].order).toBe(1);
	service.dispose();
});

it("represents unsupported attachments explicitly without exposing their bytes", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	const connection = service.connect();
	await connection[Symbol.asyncIterator]().next();
	f.emit({
		type: "message_end",
		message: {
			role: "user",
			timestamp: 1,
			content: [{ type: "image", mimeType: "image/png", data: "private-binary" }],
		},
	});
	const frame = (await connection[Symbol.asyncIterator]().next()).value;
	expect(frame.event.message.text).toContain("Image");
	expect(frame.event.message.content).toEqual([
		expect.objectContaining({ type: "image", asset: expect.objectContaining({ mimeType: "image/png" }) }),
	]);
	expect(JSON.stringify(frame)).not.toContain("private-binary");
	service.dispose();
});

it("rejects ambiguous session registry matches", () => {
	const a = fixture();
	const b = fixture();
	const first = getApplicationPort(a.session);
	const second = getApplicationPort(b.session);
	try {
		expect(() => getApplicationPortForSession("session-A")).toThrow("Multiple active");
	} finally {
		first.dispose();
		second.dispose();
	}
});

it("keeps both ends of a long tool output, with a marker where it was shortened", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	const first = service.connect();
	await first[Symbol.asyncIterator]().next();
	const output = `SUMMARY: 3 pages\n${"x".repeat(40_000)}\nTAIL: exit 0`;
	f.emit({ type: "tool_execution_start", toolCallId: "long", toolName: "web", args: { url: "https://example.com" } });
	f.emit({
		type: "tool_execution_end",
		toolCallId: "long",
		toolName: "web",
		result: { content: [{ type: "text", text: output }] },
		isError: false,
	});
	first.close();
	const frame = (await service.connect()[Symbol.asyncIterator]().next()).value;
	const tool = frame.snapshot.tools.find((entry: { toolCallId: string }) => entry.toolCallId === "long");
	expect(tool.text.startsWith("SUMMARY: 3 pages")).toBe(true);
	expect(tool.text.endsWith("TAIL: exit 0")).toBe(true);
	expect(tool.text).toMatch(/characters omitted/);
	expect(tool.text.length).toBeLessThanOrEqual(16_200);
	expect(tool.hint).toBe("https://example.com");
	service.dispose();
});
it("reports the dialog a run waits on in the snapshot and live frames, and clears it when the run settles", async () => {
	const f = fixture();
	const service = getApplicationPort(f.session);
	const live = service.connect();
	const iterator = live[Symbol.asyncIterator]();
	await iterator.next();
	f.emit({ type: "agent_start" });
	await iterator.next();
	const awaiting = { kind: "approval", title: "Run bash?" } as const;
	service.publishDomain({ type: "session.awaiting", awaiting });
	expect((await iterator.next()).value).toMatchObject({ type: "event", event: { type: "session.awaiting", awaiting } });
	expect(service.getSnapshot().awaiting).toEqual(awaiting);
	service.publishDomain({ type: "session.awaiting" });
	await iterator.next();
	expect(service.getSnapshot().awaiting).toBeUndefined();
	expect("awaiting" in service.getSnapshot()).toBe(false);
	service.publishDomain({ type: "session.awaiting", awaiting });
	f.emit({ type: "agent_settled", aborted: true });
	expect(service.getSnapshot().awaiting).toBeUndefined();
	service.dispose();
});
