import { describe, expect, it } from "vitest";
import { iterateSseMessages } from "../src/utils/server-sent-events.ts";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of stream) values.push(value);
	return values;
}

function body(text: string, split: number) {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes.subarray(0, split));
			controller.enqueue(bytes.subarray(split));
			controller.close();
		},
	});
}

describe("shared provider SSE framing", () => {
	it.each(["\n", "\r", "\r\n"])(
		"preserves multiline events and Unicode at every byte split with %j lines",
		async (newline) => {
			const text = [": heartbeat", "", "event: delta", "data: שלום", "data: world", "", "data: tail"].join(newline);
			for (let split = 0; split <= new TextEncoder().encode(text).length; split++) {
				const events = await collect(iterateSseMessages(body(text, split)));
				expect(events.map(({ event, data }) => ({ event, data }))).toEqual([
					{ event: "delta", data: "שלום\nworld" },
					{ event: null, data: "tail" },
				]);
			}
		},
	);
	it("does not dispatch or retain event-only and comment-only blocks", async () => {
		const events = await collect(iterateSseMessages(body("event: ignored\n\n: ping\n\ndata: ok\n\n", 10)));
		expect(events).toEqual([{ event: null, data: "ok" }]);
	});
	it("aborts a stalled read and releases its body", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const controller = new AbortController();
		const waiting = collect(iterateSseMessages(stream, controller.signal));
		controller.abort(new Error("cancelled by user"));
		await expect(waiting).rejects.toThrow("cancelled by user");
		expect(cancelled).toBe(true);
	});
	it("cancels the body when its consumer stops after an event", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: one\n\ndata: two\n\n"));
			},
			cancel() {
				cancelled = true;
			},
		});
		for await (const event of iterateSseMessages(stream)) {
			expect(event.data).toBe("one");
			break;
		}
		expect(cancelled).toBe(true);
	});
	it("bounds an unterminated provider event", async () => {
		const text = `data: ${"x".repeat(16 * 1024 * 1024 + 1)}`;
		await expect(collect(iterateSseMessages(body(text, 1024)))).rejects.toThrow("max buffer size");
	});
});
