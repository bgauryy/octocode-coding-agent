import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationEvent, ApplicationMessage } from "@octocodeai/octocode-contracts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { jsonLength, listJsonLength, recordJsonLength } from "@octocodeai/octocode-common/json-length";
import { normalizeApplicationMessage } from "../src/core/application/normalize.ts";
import { ApplicationService } from "../src/core/application/service.ts";
import { createApplicationState } from "../src/core/application/state.ts";
import { ApplicationTranscript } from "../src/core/application/transcript.ts";
import { messageJsonLength } from "../src/core/application/transcript-stream.ts";

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
	vi.restoreAllMocks();
});

function fixture() {
	let receive: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId: "measure-once",
		messages: [] as unknown[],
		isStreaming: false,
		subscribe(listener: typeof receive) {
			receive = listener;
			return () => {
				receive = undefined;
			};
		},
	};
	const service = new ApplicationService(session as unknown as AgentSession);
	services.push(service);
	const events: ApplicationEvent[] = [];
	service.subscribe((event) => events.push(event));
	return { service, events, emit: (event: unknown) => receive?.(event as AgentSessionEvent) };
}

/** How many `JSON.stringify` calls produced text containing `marker` while `work` ran. */
function serializations(marker: string, work: () => void): number {
	const real = JSON.stringify;
	let count = 0;
	const spy = vi.spyOn(JSON, "stringify").mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
		const text = real(...args) as string | undefined;
		if (text?.includes(marker)) count++;
		return text;
	}) as typeof JSON.stringify);
	try {
		work();
	} finally {
		spy.mockRestore();
	}
	return count;
}

const tool = (service: ApplicationService, id: string) =>
	(service.getSnapshot().tools ?? []).find((entry) => entry.toolCallId === id);

/** What the agent emits when a call ends: the end event, then the message recording the same result. */
function finish(emit: (event: unknown) => void, result: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	const message = { role: "toolResult", toolCallId: "t", toolName: "read", isError: false, timestamp: 1, ...result };
	emit({ type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path: "a.ts" } });
	emit({ type: "tool_execution_end", toolCallId: "t", toolName: "read", result, isError: false });
	return { ...message, ...extra };
}

describe("a tool result is normalized once", () => {
	it("keeps the tool as its end event left it when the result message carries the same result", () => {
		const f = fixture();
		const result = { content: [{ type: "text", text: "RESULT" }], details: { rows: 2 }, structuredContent: { a: 1 } };
		const message = finish(f.emit, result);
		const before = tool(f.service, "t");
		f.emit({ type: "message_start", message });
		f.emit({ type: "message_end", message });
		expect(tool(f.service, "t")).toEqual(before);
		expect(before).toMatchObject({ status: "completed", text: "RESULT", details: { rows: 2 } });
		expect(f.service.getSnapshot().messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "t" });
	});

	it("serializes a result's details once: cloning them also measures the result data and the tool state", () => {
		const transcript = new ApplicationTranscript(createApplicationState("s"));
		const result = { content: [{ type: "text", text: "ok" }], details: { marker: "DETAILS_MARKER" } };
		const end = { type: "tool_execution_end", toolCallId: "t", toolName: "read", result, isError: false } as const;
		expect(
			serializations("DETAILS_MARKER", () => {
				const event = transcript.tool(end);
				if (event.type === "tool.completed") transcript.acceptTool(event);
			}),
		).toBe(1);
		// The message recording that result shows its own copy of the details and leaves the tool alone.
		const message = { role: "toolResult", toolCallId: "t", toolName: "read", isError: false, ...result };
		const shown = transcript.tools.get("t");
		transcript.message({ type: "message_start", message } as never, () => {});
		// Two for the message itself (its copy of the details, and its size); none for the tool.
		expect(
			serializations("DETAILS_MARKER", () => transcript.message({ type: "message_end", message } as never, () => {})),
		).toBe(2);
		expect(transcript.tools.get("t")).toBe(shown);
		expect(shown).toMatchObject({ status: "completed", details: { marker: "DETAILS_MARKER" } });
	});

	it("applies a result message that differs from what the end event reported", () => {
		const f = fixture();
		const result = { content: [{ type: "text", text: "first" }], details: { rows: 1 } };
		const replaced = finish(f.emit, result, { content: [{ type: "text", text: "second" }] });
		f.emit({ type: "message_end", message: replaced });
		expect(tool(f.service, "t")).toMatchObject({ status: "completed", text: "second" });
		// A different outcome is a different result too.
		const g = fixture();
		const failed = finish(g.emit, result, { isError: true });
		g.emit({ type: "message_end", message: failed });
		expect(tool(g.service, "t")).toMatchObject({ status: "failed" });
	});

	it("still builds the tool from the message when no end event came first (a restored session)", () => {
		const f = fixture();
		f.emit({
			type: "message_end",
			message: { role: "toolResult", toolCallId: "t", toolName: "read", content: [{ type: "text", text: "kept" }] },
		});
		expect(tool(f.service, "t")).toMatchObject({ status: "completed", text: "kept" });
	});
});

describe("display sizes are measured once", () => {
	const values: unknown[] = [
		{},
		{ a: undefined, b: () => 1 },
		{ text: 'quote " and \\ and \n and  ', n: 1.5, t: true, z: null },
		{ nested: { list: [1, "two", { three: [undefined, null] }] }, emoji: "👍", lone: "\ud83d" },
		{ long: "x".repeat(5000), again: "x".repeat(5000) },
	];

	it("adds member lengths up to exactly the serialized length", () => {
		for (const value of values) {
			expect(recordJsonLength(value as object)).toBe(JSON.stringify(value).length);
			expect(jsonLength(value)).toBe(JSON.stringify(value).length);
		}
		expect(listJsonLength(values)).toBe(JSON.stringify(values).length);
		expect(listJsonLength([undefined, () => 1, "a"])).toBe(JSON.stringify([undefined, () => 1, "a"]).length);
		expect(jsonLength(undefined)).toBeUndefined();
		// A length the caller supplies replaces measuring that member.
		expect(recordJsonLength({ a: "skipped", b: 1 }, { a: 3 })).toBe('{"a":123,"b":1}'.length);
	});

	it("spills a large result exactly where serializing it whole did", () => {
		for (const size of [59_000, 61_000]) {
			const f = fixture();
			const result = { content: [{ type: "text", text: "ok" }], details: { rows: ["r".repeat(size)] } };
			finish(f.emit, result);
			const state = tool(f.service, "t");
			// Structured data past 8,000 characters moves to an asset that holds exactly its serialized form.
			expect(state?.details).toBeUndefined();
			expect(f.service.readAsset(state!.full!.id)?.data).toBe(JSON.stringify({ details: result.details }));
		}
		// Result data past the inline limit moves whole to an asset, and data just under it stays inline.
		for (const [blocks, spilled] of [
			[40, false],
			[70, true],
		] as const) {
			const f = fixture();
			const content = Array.from({ length: blocks }, () => ({ type: "text", text: "t".repeat(1000) }));
			finish(f.emit, { content, details: {} });
			expect(tool(f.service, "t")?.text === "[Full tool result available]").toBe(spilled);
		}
	});

	it("measures a streaming message from its blocks, equal to serializing it", () => {
		const block = (id: string, text: string) => ({ id, type: "text" as const, text });
		const message = (content: ApplicationMessage["content"], extra: Partial<ApplicationMessage> = {}) => {
			const text = (content ?? []).map((item) => ("text" in item ? item.text : "")).join("\n");
			return { id: "m", role: "assistant", content, text, complete: false, status: "streaming", ...extra } as const;
		};
		const cases: ApplicationMessage[] = [
			message([]),
			message([block("m:0", 'a "quoted" line\n'), block("m:1", "\ud83d"), block("m:2", "\udc4d tail")]),
			message([block("m:0", "plain")], { usage: { input: 3 }, model: "x", details: { a: [1, 2] } }),
			{ id: "m", role: "assistant", text: "", complete: false, status: "streaming" },
		];
		for (const item of cases) expect(messageJsonLength(item)).toBe(JSON.stringify(item).length);
	});

	it("does not serialize the blocks a delta left alone", () => {
		const transcript = new ApplicationTranscript(createApplicationState("s"));
		const events: ApplicationEvent[] = [];
		const partial = { role: "assistant", content: [] as { type: string; text: string }[], stopReason: "stop" };
		const update = (assistantMessageEvent: object) =>
			transcript.message({ type: "message_update", message: partial, assistantMessageEvent } as never, (event) => {
				events.push(event);
			});
		transcript.message({ type: "message_start", message: partial } as never, () => {});
		partial.content.push({ type: "text", text: "EARLIER_BLOCK" });
		update({ type: "text_start", contentIndex: 0 });
		partial.content.push({ type: "text", text: "" });
		update({ type: "text_start", contentIndex: 1 });
		const token = (delta: string) => {
			partial.content[1].text += delta;
			update({ type: "text_delta", contentIndex: 1, delta });
		};
		token("warm");
		// The size check adds the earlier block's remembered length, and the extended block's grows by the delta's.
		expect(serializations("EARLIER_BLOCK", () => token(" more"))).toBe(0);
		expect(serializations("warm more", () => token("!"))).toBe(0);
		const shown = [...transcript.messages.values()].at(-1);
		expect(shown?.content?.map((item) => ("text" in item ? item.text : ""))).toEqual(["EARLIER_BLOCK", "warm more!"]);
		expect(shown && messageJsonLength(shown)).toBe(JSON.stringify(shown).length);
		expect(events.at(-1)).toMatchObject({ type: "message.delta", delta: "!" });
	});

	it("measures each delta exactly across escapes, split surrogate pairs and the preview threshold", () => {
		const transcript = new ApplicationTranscript(createApplicationState("s"));
		const partial = { role: "assistant", content: [] as { type: string; text: string }[], stopReason: "stop" };
		const update = (assistantMessageEvent: object) =>
			transcript.message({ type: "message_update", message: partial, assistantMessageEvent } as never, () => {});
		transcript.message({ type: "message_start", message: partial } as never, () => {});
		partial.content.push({ type: "text", text: "" });
		update({ type: "text_start", contentIndex: 0 });
		const pieces = ['say "hi"\n', "\ud83d", "\udc4d\t", "\u0001 ", "x".repeat(997)];
		for (let round = 0; round < 6; round++)
			for (const delta of pieces) {
				partial.content[0].text += delta;
				update({ type: "text_delta", contentIndex: 0, delta });
				const shown = [...transcript.messages.values()].at(-1)!;
				expect(messageJsonLength(shown)).toBe(JSON.stringify(shown).length);
			}
		expect([...transcript.messages.values()].at(-1)?.content?.[0]).toHaveProperty("full");
	});

	it("still replaces a streaming message that outgrows the inline limit with its asset", () => {
		const transcript = new ApplicationTranscript(createApplicationState("s"));
		const partial = { role: "assistant", content: [] as { type: string; text: string }[], stopReason: "stop" };
		const update = (assistantMessageEvent: object) =>
			transcript.message({ type: "message_update", message: partial, assistantMessageEvent } as never, () => {});
		transcript.message({ type: "message_start", message: partial } as never, () => {});
		// Each block is shown whole (under the preview size); together they pass the message limit on a later delta.
		for (let index = 0; index < 20; index++) {
			partial.content.push({ type: "text", text: "" });
			update({ type: "text_start", contentIndex: index });
			for (let piece = 0; piece < 7; piece++) {
				partial.content[index].text += "x".repeat(500);
				update({ type: "text_delta", contentIndex: index, delta: "x".repeat(500) });
				const shown = [...transcript.messages.values()].at(-1)!;
				const whole = normalizeApplicationMessage({ ...partial, stopReason: "pending" }, shown.id, transcript.assets);
				// At every delta the message shown equals normalizing the whole partial message.
				expect({ ...shown, order: undefined }).toEqual({ ...whole, order: undefined });
			}
		}
		expect([...transcript.messages.values()].at(-1)?.text).toBe("[Full message available]");
	});
});
