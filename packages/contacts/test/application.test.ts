import { expect, it } from "vitest";
import { Value } from "typebox/value";
import { ApplicationCommandSchema, parseApplicationFrame } from "../src/application.ts";
it("validates activity provenance and bounds in event, snapshot and reset frames", () => {
	const envelope = { protocolVersion: 1, cursor: { sessionId: "session", epoch: "epoch", sequence: 1 }, at: 1 };
	const activity = {
		id: "entry:usage",
		entryId: "usage",
		kind: "usage",
		at: 1,
		text: "Usage",
		source: "session",
		data: { input: 5 },
	};
	const event = { ...envelope, type: "event", event: { type: "session.activity", activity } };
	expect(parseApplicationFrame(event)).toEqual(event);
	expect(
		parseApplicationFrame({ ...event, event: { ...event.event, activity: { ...activity, source: "provider" } } }),
	).toBeUndefined();
	expect(
		parseApplicationFrame({ ...event, event: { ...event.event, activity: { ...activity, text: "x".repeat(4001) } } }),
	).toBeUndefined();
	expect(
		parseApplicationFrame({
			...event,
			event: {
				type: "session.reset",
				messages: [],
				tools: [],
				activities: [activity],
				activityBefore: activity.id,
				hasMoreActivities: true,
			},
		})?.type,
	).toBe("event");
	expect(
		parseApplicationFrame({
			...envelope,
			type: "snapshot",
			snapshot: {
				sessionId: "session",
				messages: [],
				streaming: false,
				steering: [],
				followUp: [],
				receipts: [],
				capabilities: [],
				activities: [activity],
				activityBefore: activity.id,
				hasMoreActivities: false,
			},
		})?.type,
	).toBe("snapshot");
});
it("validates command variants and rejects injected authority", () => {
	expect(
		Value.Check(ApplicationCommandSchema, {
			id: "req",
			sessionId: "session",
			action: "prompt",
			text: "hello",
		}),
	).toBe(true);
	expect(
		Value.Check(ApplicationCommandSchema, {
			id: "req",
			sessionId: "session",
			action: "abort",
		}),
	).toBe(false);
	expect(
		Value.Check(ApplicationCommandSchema, {
			id: "req",
			sessionId: "session",
			action: "prompt",
			text: "hello",
			actor: "admin",
		}),
	).toBe(false);
});
it("rejects malformed stream variants and incompatible versions", () => {
	const frame = {
		protocolVersion: 1,
		cursor: { sessionId: "session", epoch: "epoch", sequence: 2 },
		at: 12,
		type: "event",
		event: { type: "message.delta", messageId: "message", delta: "text" },
	};
	expect(parseApplicationFrame(frame)).toEqual(frame);
	expect(
		parseApplicationFrame({ ...frame, fromSequence: 1, event: { ...frame.event, text: "complete" } }),
	).toMatchObject({ fromSequence: 1 });
	expect(parseApplicationFrame({ ...frame, fromSequence: -1 })).toBeUndefined();
	expect(parseApplicationFrame({ ...frame, fromSequence: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
	expect(parseApplicationFrame({ ...frame, protocolVersion: 2 })).toBeUndefined();
	expect(
		parseApplicationFrame({
			...frame,
			cursor: { ...frame.cursor, sequence: Number.MAX_SAFE_INTEGER + 1 },
		}),
	).toBeUndefined();
	expect(
		parseApplicationFrame({
			...frame,
			event: { type: "message.delta", delta: "text" },
		}),
	).toBeUndefined();
	expect(parseApplicationFrame({ ...frame, event: { type: "invented" } })).toBeUndefined();
	expect(
		parseApplicationFrame({
			...frame,
			event: { type: "tool.started", toolCallId: "tool", toolName: "read", order: 1 },
		})?.type,
	).toBe("event");
	expect(
		parseApplicationFrame({
			...frame,
			event: { type: "tool.started", toolCallId: "tool", toolName: "read", order: -1 },
		}),
	).toBeUndefined();
});
