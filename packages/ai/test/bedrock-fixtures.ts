/** bedrockFrame wraps one {eventName: payload} in a checksummed AWS frame. bedrockResponse streams frames in order; bedrockTextEvents is a complete text response. No AWS/Smithy imports are needed. */
import { getBuiltinModel } from "../src/providers/all.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
export const bedrockModel = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
export const bedrockContext = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
const encoder = new TextEncoder();
function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function header(name: string, value: string): Uint8Array {
	const key = encoder.encode(name);
	const text = encoder.encode(value);
	const result = new Uint8Array(1 + key.length + 3 + text.length);
	result[0] = key.length;
	result.set(key, 1);
	result[1 + key.length] = 7;
	new DataView(result.buffer).setUint16(key.length + 2, text.length);
	result.set(text, key.length + 4);
	return result;
}
export function bedrockFrame(event: Record<string, unknown>): Uint8Array {
	const [name, value] = Object.entries(event)[0];
	const exception = name.endsWith("Exception");
	const headers = [
		header(":message-type", exception ? "exception" : "event"),
		header(exception ? ":exception-type" : ":event-type", name),
		header(":content-type", "application/json"),
	];
	const size = headers.reduce((total, h) => total + h.length, 0);
	const body = encoder.encode(JSON.stringify(value));
	const result = new Uint8Array(16 + size + body.length);
	const view = new DataView(result.buffer);
	view.setUint32(0, result.length);
	view.setUint32(4, size);
	view.setUint32(8, crc32(result.subarray(0, 8)));
	let offset = 12;
	for (const h of headers) {
		result.set(h, offset);
		offset += h.length;
	}
	result.set(body, offset);
	view.setUint32(result.length - 4, crc32(result.subarray(0, -4)));
	return result;
}
export function bedrockResponse(events: Record<string, unknown>[], headers: Record<string, string> = {}): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) controller.enqueue(bedrockFrame(event));
				controller.close();
			},
		}),
		{ headers: { "content-type": "application/vnd.amazon.eventstream", ...headers } },
	);
}
export const bedrockTextEvents = [
	{ messageStart: { role: "assistant" } },
	{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
	{ contentBlockStop: { contentBlockIndex: 0 } },
	{ messageStop: { stopReason: "end_turn" } },
	{ metadata: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, metrics: { latencyMs: 1 } } },
];
