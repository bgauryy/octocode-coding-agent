import { expect, it } from "vitest";
import { Value } from "typebox/value";
import {
	ApplicationCommandSchema,
	applicationCommandFingerprint,
	parseApplicationFrame,
	isPendingApplicationPhase,
	isTerminalApplicationPhase,
	parseApplicationTool,
} from "../src/application.ts";
import { APPLICATION_NOTICE_KIND, applicationNotice } from "../src/application-notice.ts";
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

it("validates a hold on a blocking dialog: only the dialog id, and its fingerprint differs from an answer's", () => {
	const hold = { id: "req", sessionId: "session", action: "hold", dialogId: "d1" };
	expect(Value.Check(ApplicationCommandSchema, hold)).toBe(true);
	expect(Value.Check(ApplicationCommandSchema, { ...hold, dialogId: undefined })).toBe(false);
	expect(Value.Check(ApplicationCommandSchema, { ...hold, dialogId: "" })).toBe(false);
	expect(Value.Check(ApplicationCommandSchema, { ...hold, choice: "a" })).toBe(false);
	expect(JSON.parse(applicationCommandFingerprint(hold as never))).toEqual(hold);
	expect(applicationCommandFingerprint({ ...hold, dialogId: "d2" } as never)).not.toBe(
		applicationCommandFingerprint(hold as never),
	);
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

it("carries the session phase in events and snapshots; terminal and pending phases are told apart", () => {
	const frame = { protocolVersion: 1, cursor: { sessionId: "s", epoch: "e", sequence: 1 }, at: 1, type: "event" };
	const waiting = { state: "waiting", agents: 1, queued: 0, bash: 0, external: 0 } as const;
	expect(
		parseApplicationFrame({ ...frame, event: { type: "session.phase", phase: waiting, jobStartedAt: 7 } }),
	).toBeDefined();
	expect(
		parseApplicationFrame({
			...frame,
			event: { type: "session.phase", phase: { state: "failed", error: "x".repeat(301) } },
		}),
	).toBeUndefined();
	expect(
		parseApplicationFrame({
			...frame,
			type: "snapshot",
			snapshot: {
				sessionId: "s",
				messages: [],
				streaming: false,
				steering: [],
				followUp: [],
				receipts: [],
				capabilities: [],
				phase: { state: "scheduled", timers: 1, id: "t1", dueAt: 9 },
			},
		}),
	).toBeDefined();
	expect(
		[waiting, { state: "resuming" }, { state: "scheduled", timers: 1, id: "t" }].map((p) =>
			isPendingApplicationPhase(p as never),
		),
	).toEqual([true, true, true]);
	expect(
		[{ state: "done" }, { state: "idle" }, { state: "stopped", open: ["B1"] }, { state: "failed", error: "e" }].map(
			(p) => isTerminalApplicationPhase(p as never),
		),
	).toEqual([true, true, true, true]);
	expect(isTerminalApplicationPhase(waiting)).toBe(false);
	expect(isPendingApplicationPhase({ state: "working" })).toBe(false);
	expect(isTerminalApplicationPhase({ state: "blocked", title: "q" })).toBe(false);
});

it("reads a notice activity's level, defaulting to info, and nothing from other activities", () => {
	const base = { id: "n", at: 1, source: "live" as const, text: "Cache warmed" };
	expect(applicationNotice({ ...base, kind: APPLICATION_NOTICE_KIND, data: { level: "warning" } })).toEqual({
		text: "Cache warmed",
		level: "warning",
	});
	expect(applicationNotice({ ...base, kind: APPLICATION_NOTICE_KIND, data: { level: "loud" } })?.level).toBe("info");
	expect(applicationNotice({ ...base, kind: APPLICATION_NOTICE_KIND })?.level).toBe("info");
	expect(applicationNotice({ ...base, kind: "turn_start" })).toBeUndefined();
});
