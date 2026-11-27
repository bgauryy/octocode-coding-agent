import { describe, expect, it } from "vitest";
import { traceOf } from "./matchers-fixtures.ts";

const usage = (promptTokens: number, completionTokens: number, cachedTokens = 0, estimated = false) => ({
	usage: { promptTokens, completionTokens, cachedTokens, estimated },
});

describe("toStayWithin", () => {
	const t = traceOf([], [usage(100, 10, 50), usage(200, 20, 100)]);

	it("passes when every limit holds", () => {
		expect(t).toStayWithin({ requests: 2, promptTokens: 300, completionTokens: 30, cachedTokensAtLeast: 150 });
	});

	it("names each limit exceeded with actual versus limit", () => {
		expect(() => expect(t).toStayWithin({ requests: 1, promptTokens: 299, completionTokens: 29 })).toThrow(
			/requests 2 > 1; promptTokens 300 > 299; completionTokens 30 > 29/,
		);
		expect(() => expect(t).toStayWithin({ cachedTokensAtLeast: 151 })).toThrow(/cachedTokens 150 < 151/);
	});

	it("says (estimated) when usage is estimated", () => {
		const e = traceOf([], [usage(100, 1, 0, true)]);
		expect(() => expect(e).toStayWithin({ promptTokens: 1 })).toThrow(/\(estimated\)/);
		expect(() => expect(t).toStayWithin({ promptTokens: 1 })).not.toThrow(/\(estimated\)/);
	});

	it("filters by agent", () => {
		const m = traceOf(
			[],
			[
				{ agent: "a", ...usage(100, 1) },
				{ agent: "b", ...usage(500, 1) },
			],
		);
		expect(m).toStayWithin({ promptTokens: 100, requests: 1, agent: "a" });
		expect(() => expect(m).toStayWithin({ promptTokens: 100, agent: "b" })).toThrow(/promptTokens 500 > 100/);
	});

	it("works under .not", () => {
		expect(t).not.toStayWithin({ requests: 1 });
		expect(() => expect(t).not.toStayWithin({ requests: 5 })).toThrow(/to be exceeded/);
	});

	it("a request limit alone needs no usage; a token limit does, also under .not", () => {
		const n = traceOf([], [{}]);
		expect(n).toStayWithin({ requests: 1 });
		expect(() => expect(n).not.toStayWithin({ completionTokens: 1 })).toThrow(/cannot observe: no usage/);
	});
});
