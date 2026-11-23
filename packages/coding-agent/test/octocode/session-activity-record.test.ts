import type { ActivityTone } from "@octocodeai/octocode-contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/registry.ts";
import type { ApplicationService } from "../../src/core/application/service.ts";
import { SessionActivityRecord } from "../../src/octocode/sessions/activity-record.ts";

/**
 * The cross-process light (RFC 2026-11-23-app-state, T4): the process that has a session open writes its light's tone to
 * the agent database when the tone changes, never per store notification, so `/resume` and `coordinate list` in another
 * process can show what it is doing.
 */

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
});

function scriptedSession(sessionId: string) {
	let receive: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId,
		messages: [] as unknown[],
		isStreaming: false,
		subscribe(listener: (event: AgentSessionEvent) => void) {
			receive = listener;
			return () => {
				receive = undefined;
			};
		},
	};
	const port = getApplicationPort(session as unknown as AgentSession);
	services.push(port);
	const emit = (event: unknown) => receive?.(event as AgentSessionEvent);
	const reply = (deltas: number) => {
		const partial = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
		emit({ type: "message_start", message: { ...partial } });
		for (let index = 0; index < deltas; index++) {
			partial.content[0].text += `w${index} `;
			emit({
				type: "message_update",
				message: { ...partial },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `w${index} `, partial },
			});
		}
		emit({ type: "message_end", message: { ...partial, content: [{ ...partial.content[0] }] } });
	};
	return { port, emit, reply };
}

describe("the session's light in the agent database", () => {
	it("writes the tone when it changes, not per notification, and nothing after it stops", () => {
		const { port, emit, reply } = scriptedSession("record-path");
		let notifications = 0;
		const stopCounting = port.stateSource.subscribe(() => notifications++);
		const writes: Array<[string, ActivityTone]> = [];
		const record = new SessionActivityRecord((id, tone) => {
			writes.push([id, tone]);
		});
		// The session's start wrote `idle` to its row.
		record.follow("record-path", "idle");

		emit({ type: "agent_start" });
		reply(200);
		// The phase's words change while the run goes on: the tone does not, so nothing is written.
		port.publishDomain({ type: "session.phase", phase: { state: "working", activity: "Running bash" } });
		port.publishDomain({ type: "session.awaiting", awaiting: { kind: "approval", title: "Run bash?" } });
		port.publishDomain({ type: "session.awaiting" });
		port.publishDomain({ type: "session.status", status: "compacting" });
		port.publishDomain({ type: "session.status", status: "idle" });
		emit({ type: "agent_settled", aborted: false });
		port.publishDomain({ type: "session.phase", phase: { state: "failed", error: "401 Unauthorized" } });
		record.close();
		port.publishDomain({ type: "session.phase", phase: { state: "done" } });
		stopCounting();

		expect(writes).toEqual([
			["record-path", "working"],
			["record-path", "waiting"],
			["record-path", "working"],
			["record-path", "error"],
		]);
		expect(notifications).toBeGreaterThan(200);
	});

	it("follows the session it is told to, from a port that opens later, and drops the one before", () => {
		const writes: Array<[string, ActivityTone]> = [];
		const record = new SessionActivityRecord((id, tone) => {
			writes.push([id, tone]);
		});
		record.follow("first", "idle");
		record.follow("second");
		const first = scriptedSession("first");
		const second = scriptedSession("second");
		first.emit({ type: "agent_start" });
		second.emit({ type: "agent_start" });
		record.close();
		// With no tone recorded for it, the second session's light is written at once.
		expect(writes).toEqual([
			["second", "idle"],
			["second", "working"],
		]);
	});
});
