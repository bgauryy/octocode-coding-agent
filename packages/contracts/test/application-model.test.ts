import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
	ApplicationCommandSchema,
	ApplicationSnapshotSchema,
	applicationCommandFingerprint,
	parseApplicationFrame,
	type ApplicationCommand,
} from "../src/application.ts";
import { QuotaReadingSchema } from "../src/application-model.ts";

const identity = { id: "req", sessionId: "session" };
const snapshot = {
	sessionId: "session",
	messages: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: ["prompt", "setModel", "setThinking"],
};
const reading = {
	provider: "openai-codex",
	window: "primary",
	label: "5h",
	usedFraction: 0.62,
	resetsAt: 2,
	kind: "plan",
	source: "header",
	observedAt: 1,
};
const event = (body: Record<string, unknown>) => ({
	protocolVersion: 1,
	cursor: { sessionId: "session", epoch: "e", sequence: 1 },
	at: 1,
	type: "event",
	event: body,
});

describe("model commands", () => {
	it("accepts setModel and setThinking with their fields only", () => {
		const check = (command: unknown) => Value.Check(ApplicationCommandSchema, command);
		expect(check({ ...identity, action: "setModel", provider: "openai", modelId: "gpt-6.1" })).toBe(true);
		expect(check({ ...identity, action: "setThinking", level: "high" })).toBe(true);
		expect(check({ ...identity, action: "setModel", provider: "openai" })).toBe(false);
		expect(check({ ...identity, action: "setModel", provider: "", modelId: "x" })).toBe(false);
		expect(check({ ...identity, action: "setModel", provider: "a", modelId: "b", text: "hi" })).toBe(false);
		expect(check({ ...identity, action: "setThinking", level: "extreme" })).toBe(false);
		expect(check({ ...identity, action: "setThinking" })).toBe(false);
	});

	it("fingerprints the chosen model and level, and keeps earlier commands' fingerprints", () => {
		const pick = (modelId: string): ApplicationCommand => ({
			...identity,
			action: "setModel",
			provider: "openai",
			modelId,
		});
		expect(JSON.parse(applicationCommandFingerprint(pick("a")))).toEqual({
			...identity,
			action: "setModel",
			provider: "openai",
			modelId: "a",
		});
		expect(applicationCommandFingerprint(pick("a"))).not.toBe(applicationCommandFingerprint(pick("b")));
		expect(applicationCommandFingerprint({ ...identity, action: "setThinking", level: "low" })).toBe(
			JSON.stringify({ ...identity, action: "setThinking", level: "low" }),
		);
		expect(applicationCommandFingerprint({ ...identity, action: "prompt", text: "hi" })).toBe(
			JSON.stringify({ ...identity, action: "prompt", text: "hi" }),
		);
	});
});

describe("model snapshot fields", () => {
	it("accepts the new capabilities and optional model, usage, quota and model list", () => {
		expect(Value.Check(ApplicationSnapshotSchema, snapshot)).toBe(true);
		expect(
			Value.Check(ApplicationSnapshotSchema, {
				...snapshot,
				model: {
					provider: "anthropic",
					id: "claude-opus-5-5",
					name: "Claude Opus 5.5",
					input: ["text", "image"],
					thinkingLevel: "high",
					thinkingLevels: ["off", "low", "medium", "high"],
					billing: "plan",
				},
				usage: { metered: 1.24, planEstimate: 3.1, unpriced: 0, contextPercent: 41.5 },
				quota: [reading],
				models: [
					{ provider: "openai", id: "gpt-6.1", name: "GPT-6.1", billing: "metered", cost: { input: 2, output: 8 } },
				],
			}),
		).toBe(true);
		expect(Value.Check(ApplicationSnapshotSchema, { ...snapshot, capabilities: ["setEverything"] })).toBe(false);
		expect(Value.Check(ApplicationSnapshotSchema, { ...snapshot, usage: { metered: 1 } })).toBe(false);
		expect(
			Value.Check(ApplicationSnapshotSchema, {
				...snapshot,
				model: { provider: "a", id: "b", name: "B", input: ["text"], billing: "free" },
			}),
		).toBe(false);
	});

	it("names the provider's kind in the footer's words on the model and each listed model", () => {
		const model = { provider: "faux", id: "faux-1", name: "Faux", input: ["text"], billing: "metered" };
		const option = { provider: "faux", id: "faux-1", name: "Faux", billing: "metered" };
		const check = (kind: string) =>
			Value.Check(ApplicationSnapshotSchema, { ...snapshot, model: { ...model, kind }, models: [{ ...option, kind }] });
		for (const kind of ["subscription", "API key", "account", "CLI", "local"]) expect(check(kind)).toBe(true);
		expect(check("per token")).toBe(false);
	});

	it("bounds a quota reading to the shape the quota parsers produce", () => {
		expect(Value.Check(QuotaReadingSchema, reading)).toBe(true);
		const { resetsAt: _resetsAt, ...noReset } = reading;
		expect(Value.Check(QuotaReadingSchema, noReset)).toBe(true);
		expect(Value.Check(QuotaReadingSchema, { ...reading, usedFraction: 1.5 })).toBe(false);
		expect(Value.Check(QuotaReadingSchema, { ...reading, kind: "daily" })).toBe(false);
		expect(Value.Check(QuotaReadingSchema, { ...reading, source: "poll" })).toBe(false);
	});

	it("carries usage, quota and the model list in stream events, and a credential error kind on messages", () => {
		expect(
			parseApplicationFrame(event({ type: "session.usage", usage: { metered: 0, planEstimate: 0, unpriced: 2 } })),
		).toBeDefined();
		expect(parseApplicationFrame(event({ type: "session.usage" }))).toBeUndefined();
		expect(parseApplicationFrame(event({ type: "session.quota", quota: [reading] }))).toBeDefined();
		expect(parseApplicationFrame(event({ type: "session.models", models: [] }))).toBeDefined();
		const message = { id: "m", role: "assistant", text: "", complete: true, errorKind: "credential" };
		expect(parseApplicationFrame(event({ type: "message.completed", message }))).toBeDefined();
		expect(
			parseApplicationFrame(event({ type: "message.completed", message: { ...message, errorKind: "billing" } })),
		).toBeUndefined();
	});
});
