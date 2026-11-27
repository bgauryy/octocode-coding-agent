import { describePayloadLayers, PayloadLayerMemo, type RequestTrace } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TraceIndex } from "../../src/core/session-manager/codec-trace.ts";

/**
 * A request trace described through a memo shares its unchanged layers with the previous request's trace, so the
 * session file's delta encoding takes its identity path (no read-back of the decoded trace) and writes the very bytes
 * it writes for a freshly described trace.
 */

function payloads(turns: number): Record<string, unknown>[] {
	const wire: Record<string, unknown>[] = [];
	const out: Record<string, unknown>[] = [];
	for (let turn = 1; turn <= turns; turn++) {
		wire.push({ role: "user", content: [{ type: "text", text: `Turn ${turn}: ${"look. ".repeat(turn % 5)}` }] });
		const marked = wire.map((message, index) =>
			index === wire.length - 1
				? { ...message, content: [{ ...(message.content as object[])[0], cache_control: { type: "ephemeral" } }] }
				: { ...message },
		);
		out.push({
			tools: [{ name: "bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral", ttl: "1h" } }],
			system: [{ type: "text", text: "system", cache_control: { type: "ephemeral", ttl: "1h" } }],
			messages: marked,
		});
		wire.push({ role: "assistant", content: `Answer ${turn}` });
		// A compaction a third of the way: the history restarts.
		if (turn === Math.floor(turns / 3)) wire.splice(0, wire.length - 2);
	}
	return out;
}

/** The stored form of each trace, in order, as the codec writes them. */
function stored(traces: RequestTrace[]): string[] {
	const index = new TraceIndex();
	return traces.map((trace, i) => {
		const line = JSON.stringify(index.encode(trace));
		index.add(`entry-${i}`, trace);
		return line;
	});
}

afterEach(() => vi.restoreAllMocks());

describe("request traces from a memo in the session file", () => {
	it("round-trips a copied trace that retains a resumed session's frozen layers", () => {
		const [payload] = payloads(1);
		const index = new TraceIndex();
		const resumed = index.share(describePayloadLayers("anthropic-messages", payload)!);
		const copied = { ...resumed };
		index.add("first", describePayloadLayers("anthropic-messages", payload)!);
		expect(Object.isFrozen(copied.layers)).toBe(true);
		const stored = index.encode(copied);
		expect(stored).toHaveProperty("base", "first");
		if (!("base" in stored)) throw new Error("Expected a stored trace delta");
		expect(index.decode(stored)).toEqual(copied);
	});

	it("are stored byte for byte as fresh traces are, without the read-back", () => {
		const requests = payloads(30);
		const fresh = requests.map((payload) => describePayloadLayers("anthropic-messages", payload)!);
		const memo = new PayloadLayerMemo();
		const shared = requests.map((payload) => describePayloadLayers("anthropic-messages", payload, memo)!);
		expect(shared.map((trace) => JSON.stringify(trace))).toEqual(fresh.map((trace) => JSON.stringify(trace)));

		const decode = vi.spyOn(TraceIndex.prototype, "decode");
		const freshLines = stored(fresh.map((trace) => ({ ...trace, layers: trace.layers.slice() })));
		const freshReadBacks = decode.mock.calls.length;
		decode.mockClear();
		const sharedLines = stored(shared);
		expect(sharedLines).toEqual(freshLines);
		expect(sharedLines.filter((line) => line.includes('"base"')).length).toBeGreaterThan(20);
		// Fresh layers prove each delta by decoding it; shared ones are the base's own objects.
		expect(freshReadBacks).toBeGreaterThan(20);
		expect(decode).not.toHaveBeenCalled();
	});
});
