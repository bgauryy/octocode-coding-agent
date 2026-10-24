import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationSnapshot } from "@octocodeai/octocode-contacts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { getApplicationPort, type ApplicationService } from "../src/core/application/index.ts";

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
	vi.restoreAllMocks();
});
function fixture() {
	let receive: ((event: AgentSessionEvent) => void) | undefined;
	const host = {
		sessionId: "session-a",
		messages: [] as unknown[],
		isStreaming: false,
		subscribe: vi.fn((listener: typeof receive) => {
			receive = listener;
			return () => {
				receive = undefined;
			};
		}),
		prompt: vi.fn(async () => {}),
	};
	const session = host as unknown as AgentSession;
	const service = getApplicationPort(session);
	services.push(service);
	return { host, session, service, emit: (event: unknown) => receive?.(event as AgentSessionEvent) };
}

describe("shared application state", () => {
	it("commits run and queue state before local events and snapshot subscribers observe it", async () => {
		const f = fixture();
		expect(getApplicationPort(f.session)).toBe(f.service);
		const snapshots: ApplicationSnapshot[] = [];
		f.service.subscribeState((snapshot) => snapshots.push(snapshot));
		let atSettled: ApplicationSnapshot | undefined;
		f.service.subscribe((event) => {
			if (event.type === "run.settled") atSettled = f.service.getSnapshot();
		});
		f.emit({ type: "agent_start" });
		const running = f.service.getSnapshot();
		expect(running.streaming).toBe(true);
		expect(running.runId).toBeTruthy();
		f.emit({ type: "queue_update", steering: ["steer"], followUp: ["later"] });
		expect(snapshots.at(-1)).toMatchObject({ steering: ["steer"], followUp: ["later"] });
		f.emit({ type: "agent_settled", aborted: false });
		expect(atSettled).toMatchObject({ streaming: false });
		expect(atSettled?.runId).toBeUndefined();
		expect(running.streaming).toBe(true);
		expect(f.host.subscribe).toHaveBeenCalledTimes(1);
		const connection = f.service.connect();
		const frame = (await connection[Symbol.asyncIterator]().next()).value;
		expect(frame.snapshot).toEqual(f.service.getSnapshot());
		connection.close();
	});

	it("isolates snapshot mutations and listener errors, and releases subscriptions", () => {
		const f = fixture();
		vi.spyOn(console, "error").mockImplementation(() => {});
		f.service.subscribeState((snapshot) => {
			snapshot.steering.push("injected");
			if (snapshot.messages[0]) snapshot.messages[0].text = "changed";
			throw new Error("broken view");
		});
		const listener = vi.fn();
		const unsubscribe = f.service.subscribeState(listener);
		f.emit({ type: "message_end", message: { role: "user", content: "original", timestamp: 1 } });
		expect(listener).toHaveBeenCalled();
		expect(f.service.getSnapshot().messages[0].text).toBe("original");
		expect(f.service.getSnapshot().steering).toEqual([]);
		const before = listener.mock.calls.length;
		unsubscribe();
		f.emit({ type: "agent_start" });
		expect(listener).toHaveBeenCalledTimes(before);
		const disposed = vi.fn();
		f.service.subscribeState(disposed);
		f.service.dispose();
		f.emit({ type: "agent_settled", aborted: true });
		expect(disposed).not.toHaveBeenCalled();
		expect(() => f.service.getSnapshot()).toThrow("closed");
	});

	it("never publishes a new session identity with old-session content", () => {
		const f = fixture();
		f.emit({ type: "message_end", message: { role: "user", content: "old content", timestamp: 1 } });
		f.emit({ type: "agent_start" });
		const snapshots: ApplicationSnapshot[] = [];
		f.service.subscribeState((snapshot) => snapshots.push(snapshot));
		f.host.sessionId = "session-b";
		f.host.messages = [{ role: "user", content: "new branch", timestamp: 2 }];
		f.emit({ type: "queue_update", steering: [], followUp: [] });
		expect(snapshots.length).toBeGreaterThan(0);
		for (const snapshot of snapshots) {
			expect(snapshot.sessionId).toBe("session-b");
			expect(snapshot.messages.map((message) => message.text)).toEqual(["new branch"]);
			expect(snapshot.runId).toBeUndefined();
		}
	});

	it("retains immutable receipt outcomes and deduplicates dispatch", async () => {
		const f = fixture();
		const request = { id: "request", sessionId: "session-a", action: "prompt" as const, text: "hello" };
		await f.service.execute(request);
		const accepted = f.service.getSnapshot();
		await vi.waitFor(() => expect(f.service.getSnapshot().receipts[0].status).toBe("completed"));
		await f.service.execute(request);
		expect(f.host.prompt).toHaveBeenCalledTimes(1);
		expect(accepted.receipts[0].status).toBe("accepted");
		await expect(f.service.execute({ ...request, text: "changed" })).rejects.toThrow("another command");
	});

	it("does not unregister a replacement service when an old owner disposes twice", () => {
		const f = fixture();
		f.service.dispose();
		const replacement = getApplicationPort(f.session);
		services.push(replacement);
		f.service.dispose();
		expect(getApplicationPort(f.session)).toBe(replacement);
	});
});
