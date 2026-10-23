import { expect, it } from "vitest";
import { Value } from "typebox/value";
import { ApplicationCommandSchema, parseApplicationFrame } from "../src/application.ts";
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
