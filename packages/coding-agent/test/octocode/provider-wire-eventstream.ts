import { crc32 } from "node:zlib";

/** One `application/vnd.amazon.eventstream` frame: prelude, string headers, JSON payload, CRCs. */
function frame(eventType: string, payload: unknown): Buffer {
	const header = (name: string, value: string) => {
		const n = Buffer.from(name);
		const v = Buffer.from(value);
		const out = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
		out.writeUInt8(n.length, 0);
		n.copy(out, 1);
		out.writeUInt8(7, 1 + n.length);
		out.writeUInt16BE(v.length, 2 + n.length);
		v.copy(out, 4 + n.length);
		return out;
	};
	const headers = Buffer.concat([
		header(":message-type", "event"),
		header(":event-type", eventType),
		header(":content-type", "application/json"),
	]);
	const body = Buffer.from(JSON.stringify(payload));
	const total = 12 + headers.length + body.length + 4;
	const prelude = Buffer.alloc(8);
	prelude.writeUInt32BE(total, 0);
	prelude.writeUInt32BE(headers.length, 4);
	const preludeCrc = Buffer.alloc(4);
	preludeCrc.writeUInt32BE(crc32(prelude));
	const head = Buffer.concat([prelude, preludeCrc, headers, body]);
	const tail = Buffer.alloc(4);
	tail.writeUInt32BE(crc32(head));
	return Buffer.concat([head, tail]);
}

/** A Converse stream with one text answer and usage. */
export function converseStream(text: string): Buffer {
	return Buffer.concat([
		frame("messageStart", { role: "assistant" }),
		frame("contentBlockDelta", { contentBlockIndex: 0, delta: { text } }),
		frame("contentBlockStop", { contentBlockIndex: 0 }),
		frame("messageStop", { stopReason: "end_turn" }),
		frame("metadata", { usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 }, metrics: { latencyMs: 1 } }),
	]);
}
