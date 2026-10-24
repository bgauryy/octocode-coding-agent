import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationService } from "../src/core/application/service.ts";
import { createApplicationState, type ApplicationStateStore } from "../src/core/application/state.ts";
import { ApplicationTranscript } from "../src/core/application/transcript.ts";

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
});
function fixture(count: number) {
	let receive: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId: "hydration",
		isStreaming: false,
		messages: Array.from({ length: count }, (_, timestamp) => ({
			role: "user",
			content: `message ${timestamp}`,
			timestamp,
		})),
		subscribe(listener: typeof receive) {
			receive = listener;
			return () => {
				receive = undefined;
			};
		},
	};
	const service = new ApplicationService(session as unknown as AgentSession);
	services.push(service);
	const state = (service as unknown as { state: ApplicationStateStore }).state;
	return { service, session, state, emit: (event: unknown) => receive?.(event as AgentSessionEvent) };
}

describe("application hydration", () => {
	it("commits a large branch once, preserves old state, and batches subsequent branch navigation", () => {
		const f = fixture(5000);
		let commits = 0;
		let copiedEntries = 0;
		const stop = f.state.subscribe((state, previous) => {
			if (state.messages !== previous.messages) {
				commits++;
				copiedEntries += previous.messages.size;
			}
		});
		const snapshot = f.service.getSnapshot();
		expect(commits).toBe(1);
		expect(copiedEntries).toBe(0);
		expect(f.state.getState().messages.size).toBe(5000);
		expect(snapshot.messages.at(-1)?.text).toBe("message 4999");
		const before = f.state.getState();
		f.emit({ type: "message_end", message: { role: "user", content: "next", timestamp: 5000 } });
		expect(before.messages.size).toBe(5000);
		expect(f.state.getState().messages.size).toBe(5001);
		commits = 0;
		f.session.messages = f.session.messages.slice(0, 2000);
		const after = f.service.getSnapshot();
		expect(commits).toBe(2); // Clear the old branch, then commit its replacement.
		expect(after.messages.at(-1)?.text).toBe("message 1999");
		expect(before.messages.size).toBe(5000);
		stop();
	});
	it("reprojects a large history in one immutable commit and restores the previous display", () => {
		const f = fixture(1000);
		f.session.messages = f.session.messages.map((message) => ({ ...message, role: "custom", customType: "review" }));
		const original = f.service.getSnapshot();
		const retained = f.state.getState().messages;
		let commits = 0;
		let copiedEntries = 0;
		f.state.subscribe((state, previous) => {
			if (state.messages !== previous.messages) {
				commits++;
				copiedEntries += previous.messages.size;
			}
		});
		const restore = f.service.setToolOutputProjector(() => "projected");
		expect(commits).toBe(1);
		expect(copiedEntries).toBe(1000);
		expect(f.service.getSnapshot().messages.every((message) => message.text === "projected")).toBe(true);
		expect([...retained.values()].at(-1)?.text).toBe("message 999");
		restore();
		expect(commits).toBe(2);
		expect(f.service.getSnapshot()).toEqual(original);
	});
	it("preserves normalized tool state, identity, order, and complete history when batching", () => {
		const sequential = new ApplicationTranscript(createApplicationState());
		const batched = new ApplicationTranscript(createApplicationState());
		const messages = [
			{ role: "user", content: "run a tool", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "file" } }],
				timestamp: 2,
				stopReason: "toolUse",
			},
			{
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				timestamp: 3,
				isError: false,
			},
			{ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 4, stopReason: "stop" },
		];
		const load = (transcript: ApplicationTranscript) => {
			for (const message of messages)
				transcript.message({ type: "message_end", message } as AgentSessionEvent & { type: "message_end" }, () => {});
		};
		try {
			load(sequential);
			batched.batch(() => load(batched));
			expect(batched.history()).toEqual(sequential.history());
			expect(batched.window()).toEqual(sequential.window());
			expect(batched.history().tools?.[0]).toMatchObject({ toolCallId: "call", status: "completed", text: "result" });
		} finally {
			sequential.clear();
			batched.clear();
		}
	});
	it("retains valid messages and reports a failed projection while continuing hydration", () => {
		const f = fixture(3);
		Object.defineProperty(f.session.messages[1], "content", {
			get() {
				throw new Error("Unreadable content");
			},
		});
		const snapshot = f.service.getSnapshot();
		expect(snapshot.messages.map((message) => message.text)).toEqual(["message 0", "message 2"]);
		expect(snapshot.errors).toEqual([expect.objectContaining({ code: "content-unavailable" })]);
	});
});
