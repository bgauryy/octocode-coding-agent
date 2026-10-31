import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationEvent, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { ApplicationStream } from "../../webview/src/application-stream.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationService } from "../src/core/application/service.ts";

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
});
function fixture() {
	let receive: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId: "delivery-test",
		messages: [] as unknown[],
		isStreaming: false,
		subscribe(listener: typeof receive) {
			receive = listener;
			return () => {
				receive = undefined;
			};
		},
		prompt: vi.fn(async () => {}),
	};
	const service = new ApplicationService(session as unknown as AgentSession);
	services.push(service);
	return { service, session, emit: (event: unknown) => receive?.(event as AgentSessionEvent) };
}
describe("application delivery ordering", () => {
	it.each(["state", "event", "native"] as const)(
		"serializes nested %s updates for snapshots, events, and browser replay",
		async (kind) => {
			const f = fixture();
			const connection = f.service.connect();
			const iterator = connection[Symbol.asyncIterator]();
			const first = (await iterator.next()).value;
			const browser = new ApplicationStream();
			browser.accept(first);
			const nested = () => {
				if (kind === "native") f.emit({ type: "agent_settled", aborted: true });
				else f.service.publishDomain({ type: "run.settled", runId: "run", aborted: true });
			};
			if (kind === "event")
				f.service.subscribe((event) => {
					if (event.type === "run.started") nested();
				});
			else
				f.service.subscribeState((snapshot) => {
					if (snapshot.streaming) nested();
				});
			const states: boolean[] = [];
			const events: string[] = [];
			f.service.subscribeState((snapshot) => states.push(snapshot.streaming));
			f.service.subscribe((event) => events.push(event.type));
			f.emit({ type: "agent_start" });
			for (let i = 0; i < 2; i++) expect(browser.accept((await iterator.next()).value)).toBe("applied");
			expect(events).toEqual(["run.started", "run.settled"]);
			expect(states).toEqual([true, false]);
			expect(browser.snapshot).toEqual(f.service.getSnapshot());
			const resumed = f.service.connect({ cursor: first.cursor })[Symbol.asyncIterator]();
			expect((await resumed.next()).value.type).toBe("resumed");
			expect((await resumed.next()).value.event.type).toBe("run.started");
			expect((await resumed.next()).value.event.type).toBe("run.settled");
		},
	);
	it("starts new subscriptions and connections after the committed event", async () => {
		const f = fixture();
		const state = vi.fn();
		const event = vi.fn();
		let connection: ReturnType<ApplicationService["connect"]> | undefined;
		const stop = f.service.subscribeState(() => {
			stop();
			f.service.subscribeState(state);
			f.service.subscribe(event);
			connection = f.service.connect();
		});
		f.emit({ type: "agent_start" });
		expect(state).not.toHaveBeenCalled();
		expect(event).not.toHaveBeenCalled();
		const iterator = connection![Symbol.asyncIterator]();
		const initial = (await iterator.next()).value;
		expect(initial.cursor.sequence).toBe(1);
		f.emit({ type: "agent_settled", aborted: false });
		expect((await iterator.next()).value.event.type).toBe("run.settled");
		expect(state).toHaveBeenCalledTimes(1);
		expect(event).toHaveBeenCalledTimes(1);
	});
	it("discards queued publication and stops delivery when a subscriber disposes the service", async () => {
		const f = fixture();
		const connection = f.service.connect();
		const iterator = connection[Symbol.asyncIterator]();
		await iterator.next();
		const observed = vi.fn();
		f.service.subscribeState(() => {
			f.service.publishDomain({ type: "run.settled", runId: "run", aborted: true });
			f.service.dispose();
		});
		f.service.subscribe(observed);
		f.emit({ type: "agent_start" });
		expect(observed).not.toHaveBeenCalled();
		expect((await iterator.next()).done).toBe(true);
		expect((f.service as unknown as { replay: unknown[] }).replay).toEqual([]);
		expect(() => f.service.getSnapshot()).toThrow("closed");
	});
	it("queues command acceptance without exposing its receipt in an earlier notification", async () => {
		const f = fixture();
		let command: Promise<unknown> | undefined;
		f.service.subscribeState((snapshot) => {
			if (snapshot.streaming && !command)
				command = f.service.execute({ id: "queued", sessionId: f.session.sessionId, action: "prompt", text: "hello" });
		});
		const states: ApplicationSnapshot[] = [];
		const events: ApplicationEvent[] = [];
		f.service.subscribeState((snapshot) => states.push(snapshot));
		f.service.subscribe((event) => events.push(event));
		f.emit({ type: "agent_start" });
		expect(states[0].receipts).toEqual([]);
		expect(events.map((event) => event.type)).toEqual(["run.started", "command.receipt"]);
		await command;
		await vi.waitFor(() => expect(f.session.prompt).toHaveBeenCalledTimes(1));
	});
	it("does not retain partial messages after disposal during their first notification", () => {
		const f = fixture();
		f.service.subscribeState(() => f.service.dispose());
		f.emit({
			type: "message_update",
			message: { role: "assistant", timestamp: 1 },
			assistantMessageEvent: { type: "text_delta", delta: "discard", contentIndex: 0 },
		});
		const state = (f.service as unknown as { state: { getState(): { messages: ReadonlyMap<string, unknown> } } }).state;
		expect(state.getState().messages.size).toBe(0);
	});
	it("defers a branch replacement requested during notification without mixing sessions", () => {
		const f = fixture();
		let changed = false;
		f.service.subscribeState(() => {
			if (changed) return;
			changed = true;
			f.session.sessionId = "replacement";
			f.session.messages = [{ role: "user", content: "replacement content", timestamp: 2 }];
			f.service.getSnapshot();
		});
		const snapshots: ApplicationSnapshot[] = [];
		f.service.subscribeState((snapshot) => snapshots.push(snapshot));
		f.emit({ type: "agent_start" });
		expect(snapshots.map((snapshot) => snapshot.sessionId)).toEqual(["delivery-test", "replacement"]);
		expect(snapshots[0].messages).toEqual([]);
		expect(snapshots[1].messages.map((message) => message.text)).toEqual(["replacement content"]);
	});
	it("rejects a queued command after disposal without invoking the session", async () => {
		const f = fixture();
		let request: Promise<unknown> | undefined;
		f.service.subscribeState(() => {
			request = f.service.execute({
				id: "closed",
				sessionId: f.session.sessionId,
				action: "prompt",
				text: "never run",
			});
			f.service.dispose();
		});
		f.emit({ type: "agent_start" });
		await expect(request).rejects.toThrow("closed");
		expect(f.session.prompt).not.toHaveBeenCalled();
	});
	it("queues projector replacement until the current notification finishes and invalidates old replay", async () => {
		const f = fixture();
		f.session.messages = [{ role: "custom", customType: "review", content: "original", timestamp: 1 }];
		const connection = f.service.connect();
		const iterator = connection[Symbol.asyncIterator]();
		const first = (await iterator.next()).value;
		const stop = f.service.subscribeState(() => {
			stop();
			f.service.setToolOutputProjector(() => "projected");
		});
		const texts: (string | undefined)[] = [];
		f.service.subscribeState((snapshot) => texts.push(snapshot.messages[0]?.text));
		f.emit({ type: "agent_start" });
		expect(texts).toEqual(["original", "projected"]);
		expect((await iterator.next()).value.type).toBe("resync");
		const reconnected = f.service.connect({ cursor: first.cursor });
		const frame = (await reconnected[Symbol.asyncIterator]().next()).value;
		expect(frame.type).toBe("snapshot");
		expect(frame.snapshot.messages[0].text).toBe("projected");
	});
	it.each(["session", "branch"])("drops queued native content from a replaced %s", (replacement) => {
		const f = fixture();
		const stop = f.service.subscribeState(() => {
			stop();
			f.emit({ type: "message_end", message: { role: "user", content: "stale", timestamp: 1 } });
			if (replacement === "session") f.session.sessionId = "replacement";
			f.session.messages = [{ role: "user", content: "replacement", timestamp: 2 }];
			f.service.getSnapshot();
		});
		f.emit({ type: "agent_start" });
		expect(f.service.history().messages.map((message) => message.text)).toEqual(["replacement"]);
	});
});
