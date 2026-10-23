import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ApplicationService } from "../../src/core/application/index.ts";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.ts";
import type { ApplicationFrame } from "@octocodeai/octocode-contacts";
import { WorkspaceRuntime } from "../../src/octocode/workspace/runtime.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";
import { openAgentDb } from "../../src/octocode/agentdb/db.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn();
	cleanup.length = 0;
});
function setup() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "application-wire-"));
	cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	const db = openAgentDb(path.join(dir, "db"));
	cleanup.push(() => db.close());
	const store = new BacklogStore(() => db, "repo");
	const fake = fakePi();
	const ctx = fakeCtx({ cwd: dir });
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const prompt = vi.fn(async () => {});
	const session = {
		sessionId: ctx.sessionManager.getSessionId(),
		isStreaming: false,
		messages: [],
		subscribe: (f: (event: AgentSessionEvent) => void) => {
			listeners.add(f);
			return () => listeners.delete(f);
		},
		prompt,
		steer: vi.fn(),
		followUp: vi.fn(),
		abort: vi.fn(),
	} as unknown as AgentSession;
	const application = new ApplicationService(session);
	cleanup.push(() => application.dispose());
	const runtime = new WorkspaceRuntime(fake.pi, {
		database: () => db,
		members: () => [],
		traffic: () => [],
		tell: async () => ({}),
		stop: () => undefined,
		application: () => application,
	});
	const backlog = { store, actor: { id: "parent" }, session: session.sessionId, repoName: "repo" };
	return {
		application,
		session,
		prompt,
		emit: (event: AgentSessionEvent) => listeners.forEach((f) => f(event)),
		runtime,
		ctx,
		backlog,
	};
}
describe("application server boundary", () => {
	it("delivers the same live message to terminal and authenticated web, and closing web does not cancel", async () => {
		const app = setup();
		const terminal: AgentSessionEvent[] = [];
		app.application.subscribeNative((e) => terminal.push(e));
		const web = await startWorkspaceWeb(app.backlog, () => {}, app.runtime.bind(app.ctx, app.backlog));
		cleanup.push(() => web.close());
		const url = new URL(web.url);
		const socket = new WebSocket(url.origin.replace("http:", "ws:") + "/api/backlogs/live", { origin: url.origin });
		cleanup.push(() => socket.terminate());
		const frames: ApplicationFrame[] = [];
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === "application") frames.push(message.data);
		});
		await once(socket, "open");
		socket.send(JSON.stringify({ token: url.hash.slice(8), protocolVersion: 1 }));
		await vi.waitFor(() => expect(frames.some((f) => f.type === "snapshot")).toBe(true));
		const message = { role: "assistant", content: [{ type: "text", text: "" }] } as never;
		app.emit({ type: "agent_start" });
		app.emit({ type: "message_start", message });
		app.emit({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello from one engine", partial: message },
		});
		await vi.waitFor(() =>
			expect(frames.some((f) => f.type === "event" && f.event.type === "message.delta")).toBe(true),
		);
		expect(terminal.at(-1)?.type).toBe("message_update");
		socket.close();
		await once(socket, "close");
		expect(app.session.abort).not.toHaveBeenCalled();
		const response = await fetch(url.origin + "/api/application", {
			method: "POST",
			headers: { Authorization: "Bearer " + url.hash.slice(8), "Content-Type": "application/json" },
			body: JSON.stringify({ id: "request-a", sessionId: app.session.sessionId, action: "prompt", text: "Continue" }),
		});
		expect(response.status).toBe(200);
		await vi.waitFor(() => expect(app.prompt).toHaveBeenCalledTimes(1));
	});
	it("sends a burst of streamed text as a few frames that end with the whole text", async () => {
		const app = setup();
		const web = await startWorkspaceWeb(app.backlog, () => {}, app.runtime.bind(app.ctx, app.backlog));
		cleanup.push(() => web.close());
		const url = new URL(web.url);
		const socket = new WebSocket(url.origin.replace("http:", "ws:") + "/api/backlogs/live", { origin: url.origin });
		cleanup.push(() => socket.terminate());
		const frames: ApplicationFrame[] = [];
		socket.on("message", (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === "application") frames.push(message.data);
		});
		await once(socket, "open");
		socket.send(JSON.stringify({ token: url.hash.slice(8), protocolVersion: 1 }));
		await vi.waitFor(() => expect(frames.some((f) => f.type === "snapshot")).toBe(true));
		const message = { role: "assistant", content: [{ type: "text", text: "" }] } as never;
		app.emit({ type: "agent_start" });
		app.emit({ type: "message_start", message });
		for (let i = 0; i < 100; i++)
			app.emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "w" + i + " ", partial: message },
			});
		app.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }] } as never,
		});
		const deltas = () =>
			frames.flatMap((f) => (f.type === "event" && f.event.type === "message.delta" ? [f.event] : []));
		await vi.waitFor(() =>
			expect(frames.some((f) => f.type === "event" && f.event.type === "message.completed")).toBe(true),
		);
		expect(deltas().length).toBeLessThan(10);
		// The last delta before the completion carries every token, in order.
		const completed = frames.findIndex((f) => f.type === "event" && f.event.type === "message.completed");
		const last = frames
			.slice(0, completed)
			.reverse()
			.find((f) => f.type === "event" && f.event.type === "message.delta");
		expect(last?.type === "event" && last.event.type === "message.delta" && last.event.text).toBe(
			Array.from({ length: 100 }, (_, i) => "w" + i + " ").join(""),
		);
	});
	it("rejects incompatible protocol before exposing application state", async () => {
		const app = setup();
		const web = await startWorkspaceWeb(app.backlog, () => {}, app.runtime.bind(app.ctx, app.backlog));
		cleanup.push(() => web.close());
		const url = new URL(web.url);
		const socket = new WebSocket(url.origin.replace("http:", "ws:") + "/api/backlogs/live", { origin: url.origin });
		cleanup.push(() => socket.terminate());
		await once(socket, "open");
		socket.send(JSON.stringify({ token: url.hash.slice(8), protocolVersion: 999 }));
		const [code] = await once(socket, "close");
		expect(code).toBe(1008);
	});
});
