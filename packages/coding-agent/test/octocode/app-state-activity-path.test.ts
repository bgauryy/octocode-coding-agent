import type { Activity } from "@octocodeai/octocode-projections";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.ts";
import { getApplicationPort } from "../../src/core/application/registry.ts";
import type { ApplicationService } from "../../src/core/application/service.ts";
import { followSessionActivity } from "../../src/octocode/activity/session-activity.ts";

/**
 * The status light's real path (RFC 2026-11-23-app-state, slice S0): engine events reach the session's application state
 * store through its port, the dialog and the phase arrive as domain events, and the light follows one selection of the
 * store. The store notifies on every event, streamed deltas included; the light must hear only its own changes.
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
	/** One assistant reply streamed as `deltas` text pieces. */
	const reply = (deltas: number) => {
		const partial = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
		emit({ type: "message_start", message: { ...partial } });
		for (let index = 0; index < deltas; index++) {
			const delta = `word${index} `;
			partial.content[0].text += delta;
			emit({
				type: "message_update",
				message: { ...partial },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
			});
		}
		emit({ type: "message_end", message: { ...partial, content: [{ ...partial.content[0] }] } });
	};
	return { port, emit, reply };
}

const DELTAS = 200;

describe("status light on the session's application state", () => {
	it("follows idle, working, needs you, error and done while the store notifies on every streamed delta", () => {
		const { port, emit, reply } = scriptedSession("activity-path");
		let notifications = 0;
		const stopCounting = port.stateSource.subscribe(() => notifications++);
		const lights: Array<Pick<Activity, "tone" | "label">> = [];
		const stop = followSessionActivity("activity-path", ({ tone, label }) => lights.push({ tone, label }));

		emit({ type: "agent_start" });
		reply(DELTAS);
		port.publishDomain({ type: "session.awaiting", awaiting: { kind: "approval", title: "Run bash?" } });
		port.publishDomain({ type: "session.awaiting" });
		// The phase's words change while the run goes on: the light's tone and label stay.
		port.publishDomain({ type: "session.phase", phase: { state: "working", activity: "Running bash" } });
		port.publishDomain({ type: "session.phase", phase: { state: "working", activity: "Reading files" } });
		emit({ type: "agent_settled", aborted: false });
		port.publishDomain({ type: "session.phase", phase: { state: "failed", error: "401 Unauthorized" } });
		emit({ type: "agent_start" });
		emit({ type: "agent_settled", aborted: false });
		port.publishDomain({ type: "session.phase", phase: { state: "done" } });

		expect(lights).toEqual([
			{ tone: "idle", label: "idle" },
			{ tone: "working", label: "working" },
			{ tone: "waiting", label: "needs you" },
			{ tone: "working", label: "working" },
			{ tone: "error", label: "failed" },
			{ tone: "working", label: "working" },
			{ tone: "error", label: "failed" },
			{ tone: "idle", label: "done" },
		]);
		// Every delta reached the store, so a subscriber that is not narrow would repaint per token; the light repainted
		// 7 times after its first reading.
		expect(notifications).toBeGreaterThan(DELTAS);
		expect(lights.length - 1).toBeLessThan(notifications / 25);
		stop();
		stopCounting();
	});

	it("goes on following a session whose port opens after the light started", () => {
		const lights: string[] = [];
		const stop = followSessionActivity("late-port", ({ tone }) => lights.push(tone));
		const { emit } = scriptedSession("late-port");
		emit({ type: "agent_start" });
		expect(lights[0]).toBe("idle");
		expect(lights.at(-1)).toBe("working");
		stop();
		const heard = lights.length;
		emit({ type: "agent_settled", aborted: false });
		expect(lights).toHaveLength(heard);
	});
});
