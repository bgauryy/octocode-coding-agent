import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceServerFixture } from "./workspace-server-fixture.ts";

let app: Awaited<ReturnType<typeof workspaceServerFixture>>;
beforeEach(async () => {
	app = await workspaceServerFixture();
});
afterEach(async () => {
	await app.close();
	vi.restoreAllMocks();
});

describe("workspace WebSocket handlers without network I/O", () => {
	it("rejects invalid upgrades and handshakes without exposing state", () => {
		for (const headers of [{ host: "example.test" }, { origin: "https://example.test" }]) {
			const denied = app.upgrade(headers);
			expect(denied.client).toBeUndefined();
			expect(denied.raw.end).toHaveBeenCalledWith(expect.stringContaining("403 Forbidden"));
		}
		for (const hello of [
			{ token: "wrong", protocolVersion: 1 },
			{ token: app.token, protocolVersion: 999 },
			{ token: app.token, protocolVersion: 1, cursor: { sessionId: "s", epoch: "e", sequence: -1 } },
		]) {
			const socket = app.upgrade().client!;
			socket.hello(hello);
			expect(socket.closed?.code).toBe(1008);
			expect(socket.packets).toEqual([]);
		}
	});

	it("streams ordered agent output and command receipts, resumes from a cursor, and never aborts when the view closes", async () => {
		const socket = app.upgrade().client!;
		expect(socket.packets).toEqual([]);
		socket.hello({ token: app.token, protocolVersion: 1 });
		await vi.waitFor(() => expect(socket.frames()[0]?.type).toBe("snapshot"));
		expect(socket.packets.slice(0, 2).map((packet) => packet.type)).toEqual(["snapshot", "workspace"]);
		const native: AgentSessionEvent[] = [];
		app.application.subscribeNative((event) => native.push(event));
		const message = { role: "assistant", content: [{ type: "text", text: "" }] };
		app.emit({ type: "agent_start" });
		app.emit({ type: "message_start", message: message as never });
		let text = "";
		for (const delta of ["First ", "second ", "third"]) {
			text += delta;
			const partial = { ...message, content: [{ type: "text", text }] } as never;
			app.emit({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
			});
		}
		app.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "First second third" }] } as never,
		});
		await vi.waitFor(() =>
			expect(socket.frames().some((frame) => frame.type === "event" && frame.event.type === "message.completed")).toBe(
				true,
			),
		);
		const frames = socket.frames();
		const lastDelta = frames.filter((frame) => frame.type === "event" && frame.event.type === "message.delta").at(-1);
		expect(lastDelta).toMatchObject({ event: { text: "First second third", delta: "" } });
		for (let index = 1; index < frames.length; index++) {
			const frame = frames[index];
			if (frame.type !== "event") throw new Error(`Unexpected frame: ${frame.type}`);
			expect(frame.fromSequence ?? frame.cursor.sequence).toBe(frames[index - 1].cursor.sequence + 1);
		}
		expect(native.filter((event) => event.type === "message_update")).toHaveLength(3);
		const cursor = frames.at(-1)!.cursor;
		socket.close();
		expect(app.session.abort).not.toHaveBeenCalled();
		const command = { id: "after-close", sessionId: app.session.sessionId, action: "prompt", text: "Continue" };
		expect((await app.request("/api/application", command)).status).toBe(200);
		await vi.waitFor(() => expect(app.session.prompt).toHaveBeenCalledOnce());
		const resumed = app.upgrade().client!;
		resumed.hello({ token: app.token, protocolVersion: 1, cursor });
		await vi.waitFor(() =>
			expect(
				resumed
					.frames()
					.some(
						(frame) =>
							frame.type === "event" &&
							frame.event.type === "command.receipt" &&
							frame.event.receipt.status === "completed",
					),
			).toBe(true),
		);
		expect(resumed.frames()[0]).toMatchObject({ type: "resumed", cursor });
		resumed.close();
		expect(app.session.abort).not.toHaveBeenCalled();
	});

	it("closes an established stream and refuses new subscriptions when the host session changes", async () => {
		const socket = app.upgrade().client!;
		socket.hello({ token: app.token, protocolVersion: 1 });
		await vi.waitFor(() => expect(socket.frames()[0]?.type).toBe("snapshot"));
		app.session.sessionId = "replacement";
		app.emit({ type: "agent_start" });
		await vi.waitFor(() => expect(socket.closed?.code).toBe(1013));
		expect(socket.frames().at(-1)).toMatchObject({ type: "resync", reason: "session-changed" });
		const late = app.upgrade().client!;
		late.hello({ token: app.token, protocolVersion: 1 });
		expect(late.closed).toBeDefined();
		expect(late.frames()).toEqual([]);
		expect(app.session.abort).not.toHaveBeenCalled();
	});

	it("isolates a failed workspace send without disconnecting healthy views or failing accepted work", async () => {
		const failed = app.upgrade().client!;
		const healthy = app.upgrade().client!;
		for (const socket of [failed, healthy]) socket.hello({ token: app.token, protocolVersion: 1 });
		await vi.waitFor(() => expect(healthy.frames()[0]?.type).toBe("snapshot"));
		const send = failed.send.bind(failed);
		vi.spyOn(failed, "send").mockImplementation((text) => {
			if (JSON.parse(text).type === "workspace") throw new Error("Browser transport closed");
			send(text);
		});
		const item = app.store.add({
			title: "Keep working",
			goal: "Keep healthy views",
			why: "A disconnected view is local",
			createdBy: "user",
		});
		const command = { id: "keep-healthy-view", action: "work", backlogId: item.ref, version: item.version };
		const result = await app.request("/api/workspace", command);
		expect(result).toMatchObject({ status: 200, body: { receipt: { id: command.id, status: "accepted" } } });
		expect(failed.closed).toBeDefined();
		expect(healthy.closed).toBeUndefined();
		expect(healthy.packets.filter((packet) => packet.type === "workspace").at(-1)?.data).toMatchObject({
			receipts: [expect.objectContaining({ id: command.id, status: "accepted" })],
		});
		expect(app.session.sendUserMessage).toHaveBeenCalledOnce();
	});

	it("builds no workspace snapshot on idle ticks and still pushes after a change", async () => {
		const socket = app.upgrade().client!;
		socket.hello({ token: app.token, protocolVersion: 1 });
		await vi.waitFor(() => expect(socket.packets.some((packet) => packet.type === "workspace")).toBe(true));
		const snapshot = vi.spyOn(app.workspace, "snapshot");
		// Two 500 ms ticks. The first sees a stamp it has not recorded: one snapshot to compare plus one to send to the
		// view. The second finds the stamp unchanged and builds nothing.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(snapshot.mock.calls.length).toBeLessThanOrEqual(2);
		const sent = socket.packets.filter((packet) => packet.type === "workspace").length;

		const item = app.store.add({ title: "Stamp", goal: "Push", why: "Stale page", createdBy: "user" });
		const command = { id: "stamp-push", action: "work", backlogId: item.ref, version: item.version };
		expect(await app.request("/api/workspace", command)).toMatchObject({ status: 200 });
		await vi.waitFor(() =>
			expect(socket.packets.filter((packet) => packet.type === "workspace").length).toBeGreaterThan(sent),
		);
		expect(socket.packets.filter((packet) => packet.type === "workspace").at(-1)?.data).toMatchObject({
			receipts: [expect.objectContaining({ id: command.id })],
		});
	});
});
