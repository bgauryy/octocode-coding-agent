// Whole-message normalization frequency by update shape for a streamed assistant text block (B64). Supported shapes
// (text_delta carrying its delta, matching the source) extend the display; others fall back to a whole normalize.
//   MEASURE_BENCH=1 yarn vitest run test/application-text-stream-shapes.bench.test.ts --disableConsoleIntercept
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationEvent } from "@octocodeai/octocode-contracts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { ApplicationService } from "../src/core/application/service.ts";
import { ApplicationTranscript } from "../src/core/application/transcript.ts";

const services: ApplicationService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
	vi.restoreAllMocks();
});

type Shape = (piece: string, partial: { content: Array<{ type: string; text: string }> }) => object;
const shapes: Record<string, Shape> = {
	"text_delta with delta (supported)": (delta) => ({ type: "text_delta", contentIndex: 0, delta }),
	"text_delta without delta": () => ({ type: "text_delta", contentIndex: 0 }),
	"custom type, no contentIndex": (delta) => ({ type: "text_chunk", delta }),
	"delta not matching the source": () => ({ type: "text_delta", contentIndex: 0, delta: "?" }),
};

function run(shape: Shape, size: number, piece: number) {
	let receive: ((event: AgentSessionEvent) => void) | undefined;
	const session = {
		sessionId: "shapes",
		messages: [] as unknown[],
		isStreaming: false,
		subscribe(listener: typeof receive) {
			receive = listener;
			return () => void (receive = undefined);
		},
	};
	const service = new ApplicationService(session as unknown as AgentSession);
	services.push(service);
	const events: ApplicationEvent[] = [];
	service.subscribe((event) => events.push(event));
	const emit = (event: unknown) => receive?.(event as AgentSessionEvent);
	const block = { type: "text", text: "" };
	const partial = { role: "assistant", content: [block], stopReason: "stop" };
	service.getSnapshot();
	emit({ type: "message_start", message: partial });
	const original = ApplicationTranscript.prototype.normalize;
	let normalizes = 0;
	let rawChars = 0;
	vi.spyOn(ApplicationTranscript.prototype, "normalize").mockImplementation(function (
		this: ApplicationTranscript,
		value,
		id,
	) {
		normalizes++;
		rawChars += block.text.length;
		return original.call(this, value, id);
	});
	const text = "The quick brown fox jumps over the lazy dog. ".repeat(Math.ceil(piece / 45)).slice(0, piece);
	const updates = Math.floor(size / piece);
	const u0 = process.cpuUsage();
	for (let i = 0; i < updates; i++) {
		block.text += text;
		emit({ type: "message_update", message: partial, assistantMessageEvent: { ...shape(text, partial), partial } });
	}
	const u1 = process.cpuUsage(u0);
	vi.restoreAllMocks();
	const published = events.filter((event) => event.type === "message.delta").length;
	return { updates, normalizes, rawChars, published, cpuMs: Math.round((u1.user + u1.system) / 1000) };
}

describe.skipIf(!process.env.MEASURE_BENCH)("whole-message normalization by update shape", () => {
	it("reports counts", () => {
		const rows = [];
		for (const [name, shape] of Object.entries(shapes))
			for (const kb of [20, 100]) rows.push({ shape: name, kb, ...run(shape, kb * 1024, 100) });
		console.log(JSON.stringify({ rows, load1: os.loadavg()[0].toFixed(1) }, null, 1));
		// Every supported update extends the display; none renormalizes the message.
		expect(rows[0].normalizes).toBeLessThan(5);
	}, 300_000);
});
