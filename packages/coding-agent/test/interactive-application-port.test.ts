import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import { subscribeToAgent } from "../src/modes/interactive/interactive-mode/agent-events.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

const sessions: AgentSession[] = [];
afterEach(() => {
	for (const session of sessions.splice(0)) getApplicationPort(session).dispose();
});

function fixture(id: string) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	let subscriptions = 0;
	const delivered: string[] = [];
	const session = {
		sessionId: id,
		messages: [],
		isStreaming: false,
		model: undefined,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		subscribe(listener: (event: AgentSessionEvent) => void) {
			subscriptions++;
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async prompt(text: string, options?: { preflightResult?: () => void }) {
			options?.preflightResult?.();
			delivered.push(text);
		},
		async abort() {
			delivered.push("aborted");
		},
	} as unknown as AgentSession;
	sessions.push(session);
	return {
		session,
		delivered,
		subscriptions: () => subscriptions,
		emit: (event: AgentSessionEvent) => {
			for (const listener of listeners) listener(event);
		},
	};
}

describe("terminal application port", () => {
	it("shares the host subscription and preserves rich events, detaching without cancelling", async () => {
		const source = fixture("terminal-session");
		const port = getApplicationPort(source.session);
		const observerEvents: AgentSessionEvent[] = [];
		const closeObserver = port.subscribeNative((event) => {
			observerEvents.push(event);
		});
		const terminalEvents: AgentSessionEvent[] = [];
		const terminal = {
			session: source.session,
			handleEvent: async (event: AgentSessionEvent) => {
				terminalEvents.push(event);
			},
			unsubscribe: undefined as undefined | (() => void),
		};
		subscribeToAgent(createFakeHost(terminal));
		const progress = {
			type: "tool_execution_update",
			toolCallId: "tool-one",
			toolName: "read",
			args: {},
			partialResult: { content: [{ type: "text", text: "partial output" }], details: { cursor: 7 } },
		} as AgentSessionEvent;
		source.emit(progress);
		expect(terminalEvents).toEqual([progress]);
		expect(terminalEvents[0]).toBe(progress);
		expect(observerEvents).toEqual(terminalEvents);
		expect(source.subscriptions()).toBe(1);
		terminal.unsubscribe!();
		source.emit({ type: "agent_end", messages: [], willRetry: false });
		expect(terminalEvents).toHaveLength(1);
		expect(observerEvents).toHaveLength(2);
		expect(source.delivered).toEqual([]);
		closeObserver();
	});

	it("ignores old-session output after the active session changes", () => {
		const previous = fixture("old-session");
		const next = fixture("new-session");
		const events: AgentSessionEvent[] = [];
		const terminal = {
			session: previous.session,
			handleEvent: async (event: AgentSessionEvent) => {
				events.push(event);
			},
			unsubscribe: undefined as undefined | (() => void),
		};
		subscribeToAgent(createFakeHost(terminal));
		terminal.session = next.session;
		previous.emit({ type: "agent_end", messages: [], willRetry: false });
		expect(events).toEqual([]);
		terminal.unsubscribe!();
		subscribeToAgent(createFakeHost(terminal));
		next.emit({ type: "agent_start" });
		expect(events).toEqual([{ type: "agent_start" }]);
		terminal.unsubscribe!();
	});

	it("preserves local prompt acceptance callbacks and single delivery", async () => {
		const source = fixture("terminal-prompts");
		let accepted = false;
		await getApplicationPort(source.session).invoke("prompt", "continue", {
			preflightResult: () => {
				accepted = true;
			},
		});
		expect(accepted).toBe(true);
		expect(source.delivered).toEqual(["continue"]);
		await getApplicationPort(source.session).invoke("abort");
		expect(source.delivered).toEqual(["continue", "aborted"]);
	});
});
