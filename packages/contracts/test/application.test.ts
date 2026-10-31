import { expect, it } from "vitest";
import { Value } from "typebox/value";
import {
	ApplicationCommandSchema,
	applicationCommandFingerprint,
	parseApplicationFrame,
	parseApplicationTool,
} from "../src/application.ts";
it("validates model input capabilities and clearing a model in stream events", () => {
	const frame = { protocolVersion: 1, cursor: { sessionId: "s", epoch: "e", sequence: 1 }, at: 1, type: "event" };
	const model = { provider: "custom", id: "vision", name: "Vision", input: ["text", "image"] };
	expect(parseApplicationFrame({ ...frame, event: { type: "session.model", model } })).toBeDefined();
	expect(parseApplicationFrame({ ...frame, event: { type: "session.model" } })).toBeDefined();
	expect(
		parseApplicationFrame({ ...frame, event: { type: "session.model", model: { ...model, input: ["unknown"] } } }),
	).toBeUndefined();
});
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
it("carries not-run tools and failed activities as optional fields that older frames omit", () => {
	const envelope = { protocolVersion: 1, cursor: { sessionId: "s", epoch: "e", sequence: 1 }, at: 1, type: "event" };
	const tool = { type: "tool.completed", toolCallId: "t", toolName: "read", failed: true, text: "Not run" };
	expect(parseApplicationFrame({ ...envelope, event: tool })).toBeDefined();
	expect(parseApplicationFrame({ ...envelope, event: { ...tool, notRun: true } })).toBeDefined();
	expect(parseApplicationFrame({ ...envelope, event: { ...tool, notRun: false } })).toBeUndefined();
	expect(
		parseApplicationTool({ toolCallId: "t", order: 0, toolName: "read", text: "", status: "failed", notRun: true }),
	).toBeDefined();
	const activity = { id: "a", kind: "compaction_end", at: 1, text: "failed", source: "live" };
	const wrap = (value: object) => ({ ...envelope, event: { type: "session.activity", activity: value } });
	expect(parseApplicationFrame(wrap(activity))).toBeDefined();
	expect(parseApplicationFrame(wrap({ ...activity, outcome: "failed" }))).toBeDefined();
	expect(parseApplicationFrame(wrap({ ...activity, outcome: "bad" }))).toBeUndefined();
});

it("validates an answer to a blocking dialog: one choice or one text, never both, never empty", () => {
	const base = { id: "req", sessionId: "session", action: "answer", dialogId: "d1" };
	expect(Value.Check(ApplicationCommandSchema, { ...base, choice: "Allow once" })).toBe(true);
	expect(Value.Check(ApplicationCommandSchema, { ...base, text: "use the other path" })).toBe(true);
	expect(Value.Check(ApplicationCommandSchema, { ...base })).toBe(false);
	expect(Value.Check(ApplicationCommandSchema, { ...base, choice: "a", text: "b" })).toBe(false);
	expect(Value.Check(ApplicationCommandSchema, { ...base, choice: "" })).toBe(false);
	expect(
		Value.Check(ApplicationCommandSchema, { id: "req", sessionId: "session", action: "answer", choice: "a" }),
	).toBe(false);
	const a = applicationCommandFingerprint({ ...base, choice: "Allow once" } as never);
	expect(JSON.parse(a)).toEqual({
		id: "req",
		sessionId: "session",
		action: "answer",
		dialogId: "d1",
		choice: "Allow once",
	});
	expect(applicationCommandFingerprint({ ...base, choice: "Deny" } as never)).not.toBe(a);
});

it("carries an answerable dialog in awaiting: id, options and whether text is accepted; older hosts omit them", () => {
	const frame = { protocolVersion: 1, cursor: { sessionId: "s", epoch: "e", sequence: 1 }, at: 1, type: "event" };
	const answerable = {
		kind: "approval",
		title: "Run rm?",
		id: "d1",
		options: ["Allow once", "Deny"],
		allowsText: false,
	};
	expect(parseApplicationFrame({ ...frame, event: { type: "session.awaiting", awaiting: answerable } })).toBeDefined();
	expect(
		parseApplicationFrame({ ...frame, event: { type: "session.awaiting", awaiting: { kind: "question" } } }),
	).toBeDefined();
	expect(
		parseApplicationFrame({
			...frame,
			event: { type: "session.awaiting", awaiting: { ...answerable, options: Array(51).fill("x") } },
		}),
	).toBeUndefined();
});
