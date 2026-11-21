import type { ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { describe, expect, it } from "vitest";
import { ApplicationProjection } from "../src/index.ts";

const session = (overrides: Partial<ApplicationSnapshot> = {}): ApplicationSnapshot => ({
	sessionId: "s",
	messages: [],
	streaming: false,
	steering: [],
	followUp: [],
	receipts: [],
	capabilities: [],
	...overrides,
});

describe("ApplicationProjection", () => {
	it("keeps the host's order of messages and tools from one snapshot", () => {
		const events = new ApplicationProjection().update(
			session({
				messages: [
					{ id: "a", role: "assistant", text: "First answer", complete: true, order: 0 },
					{ id: "b", role: "assistant", text: "Second answer", complete: true, order: 2 },
				],
				tools: [{ toolCallId: "t", toolName: "read", text: "ok", status: "completed", order: 1 }],
			}),
			10,
		);
		expect(events.map((event) => event.text.split("\n")[0])).toEqual(["First answer", "read", "Second answer"]);
		// They share the snapshot's time, so a time sort that is stable keeps that order.
		expect(new Set(events.map((event) => event.at))).toEqual(new Set([10]));
	});

	it("retains user messages and skips legacy assistant messages with no visible content", () => {
		const events = new ApplicationProjection().update(
			session({
				streaming: true,
				messages: [
					{ id: "u", role: "user", text: "question", complete: true },
					{ id: "a1", role: "assistant", text: "   ", complete: true },
					{ id: "a2", role: "assistant", text: "[Tool call: read]", complete: true },
					{ id: "a3", role: "assistant", text: "answer", complete: false },
				],
			}),
			1,
		);
		expect(events.map((item) => [item.type, item.text, (item.details as { status: string }).status])).toEqual([
			["message", "question", "completed"],
			["message", "answer", "streaming"],
		]);
	});

	it("drops tool-call and hidden-content placeholders that the feed already shows as tool events", () => {
		const events = new ApplicationProjection().update(
			session({
				messages: [
					{ id: "a", role: "assistant", text: "[Content available in the session][Tool call: write]", complete: true },
					{ id: "b", role: "assistant", text: "Let me check.[Tool call: read]", complete: true },
					{ id: "c", role: "assistant", text: "See [Image attachment: open the session to view]", complete: true },
				],
			}),
			1,
		);
		expect(events.map((event) => event.text)).toEqual([
			"Let me check.",
			"See [Image attachment: open the session to view]",
		]);
	});

	it("projects tool status into start/result events and marks failed calls with an outcome", () => {
		const events = new ApplicationProjection().update(
			session({
				tools: [
					{ toolCallId: "a", toolName: "read", text: "", status: "running" },
					{ toolCallId: "b", toolName: "bash", text: "ok", status: "completed" },
					{ toolCallId: "c", toolName: "bash", text: "err", status: "failed" },
				],
			}),
			1,
		);
		expect(events.map((item) => [item.type, item.outcome])).toEqual([
			["tool.start", undefined],
			["tool.result", undefined],
			["tool.result", "failed"],
		]);
		expect(new Set(events.map((item) => item.id)).size).toBe(3);
		expect(events.every((item) => item.id < 0)).toBe(true);
	});

	it("keeps stable ids and first-seen times while messages stream", () => {
		const projection = new ApplicationProjection();
		const first = projection.update(
			session({ messages: [{ id: "m", role: "assistant", text: "Par", complete: false }] }),
			10,
		);
		const second = projection.update(
			session({
				messages: [
					{ id: "m", role: "assistant", text: "Partial", complete: true },
					{ id: "u", role: "user", text: "Follow-up", complete: true },
				],
				tools: [{ toolCallId: "t", toolName: "read", text: "ok", status: "failed" }],
			}),
			20,
		);
		expect(first[0]).toMatchObject({ id: -1, at: 10, details: { status: "streaming" } });
		expect(second.find((event) => event.type === "message")).toMatchObject({
			id: -1,
			at: 10,
			text: "Partial",
			details: { status: "completed" },
		});
		expect(second.find((event) => event.type === "tool.result")).toMatchObject({
			id: -3,
			outcome: "failed",
			text: "read\nok",
		});
		expect(second.find((event) => event.message?.role === "user")).toMatchObject({ id: -2, text: "Follow-up" });
		expect(projection.update(session(), 30)).toEqual([]);
	});

	it("forgets events from another session", () => {
		const projection = new ApplicationProjection();
		projection.update(session({ messages: [{ id: "m", role: "assistant", text: "a", complete: true }] }), 1);
		const next = projection.update(
			session({ sessionId: "other", messages: [{ id: "m", role: "assistant", text: "b", complete: true }] }),
			5,
		);
		expect(next[0]).toMatchObject({ at: 5, text: "b" });
	});

	it("keeps a streaming projection's untouched events identical between deltas", () => {
		const projection = new ApplicationProjection();
		const base = { id: "done", role: "assistant" as const, text: "final", complete: true };
		const first = projection.update(
			session({ messages: [base, { id: "live", role: "assistant", text: "a", complete: false }] }),
			1,
		);
		const second = projection.update(
			session({ messages: [base, { id: "live", role: "assistant", text: "ab", complete: false }] }),
			2,
		);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).not.toBe(first[1]);
	});

	it("records how long the run thought before its first answer", () => {
		const projection = new ApplicationProjection();
		projection.update(session({ streaming: true, runId: "r1" }), 1_000);
		expect(projection.run).toEqual({ id: "r1", startedAt: 1_000 });
		const first = projection.update(
			session({
				streaming: true,
				runId: "r1",
				messages: [{ id: "m1", role: "assistant", text: "a", complete: false }],
			}),
			13_500,
		);
		expect(first[0].details).toMatchObject({ thoughtMs: 12_500 });
		const later = projection.update(
			session({
				streaming: true,
				runId: "r1",
				messages: [
					{ id: "m1", role: "assistant", text: "ab", complete: true },
					{ id: "m2", role: "assistant", text: "c", complete: false },
				],
			}),
			20_000,
		);
		expect(later[0].details).toMatchObject({ thoughtMs: 12_500 });
		expect(later[1].details).not.toHaveProperty("thoughtMs");
		projection.update(session({ streaming: false }), 21_000);
		expect(projection.run).toBeUndefined();
	});

	it("clears the run when the session stops streaming or disappears", () => {
		const projection = new ApplicationProjection();
		projection.update(session({ streaming: true, runId: "r" }), 5);
		expect(projection.run).toEqual({ id: "r", startedAt: 5 });
		projection.update(session({ streaming: false, runId: "r" }), 6);
		expect(projection.run).toBeUndefined();
		projection.update(session({ streaming: true, runId: "r" }), 7);
		projection.update(undefined, 8);
		expect(projection.run).toBeUndefined();
	});
});
