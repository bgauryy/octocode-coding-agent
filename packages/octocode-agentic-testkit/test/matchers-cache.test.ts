import { describe, expect, it } from "vitest";
import { runInproc } from "../src/agents/inproc.ts";
import { cacheBreaks } from "../src/context.ts";
import { script, type StepSource } from "../src/gateway.ts";
import type { CapturedRequest, Usage } from "../src/trace.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";
import { traceOf } from "./matchers-fixtures.ts";

const used = (
	promptTokens: number,
	cachedTokens: number,
	agent = "main",
	estimated = false,
): Partial<CapturedRequest> => ({
	agent,
	usage: { promptTokens, cachedTokens, completionTokens: 10, estimated } satisfies Usage,
});

describe("cacheBreaks / toKeepCacheWarm", () => {
	it("a warm chain passes; a cold read after the first request is a break", () => {
		const warm = traceOf([], [used(5000, 0), used(5100, 5000), used(5200, 5100)]);
		expect(warm).toKeepCacheWarm();
		const cold = traceOf([], [used(5000, 0), used(5100, 5000), used(5200, 0)]);
		expect(cacheBreaks(cold)).toEqual([{ agent: "main", request: 2, promptTokens: 5200, estimated: false }]);
		expect(() => expect(cold).toKeepCacheWarm()).toThrow(/request 2 \(main\) read 0 of 5200 prompt tokens from cache/);
		expect(() => expect(warm).not.toKeepCacheWarm()).toThrow(/expected a cold cache read/);
	});

	it("each agent's first request may be cold, and prompts under the cache minimum are ignored", () => {
		const t = traceOf([], [used(5000, 0), used(4000, 0, "child"), used(500, 0), used(4100, 3900, "child")]);
		expect(t).toKeepCacheWarm();
		expect(() => expect(t).toKeepCacheWarm({ minPromptTokens: 100 })).toThrow(/request 2 \(main\) read 0 of 500/);
		expect(t).toKeepCacheWarm({ minPromptTokens: 100, agent: "child" });
	});

	it("each compaction excuses one cold read of its agent", () => {
		const reqs = [used(9000, 0), used(9100, 9000), used(2000, 0), used(2100, 2000)];
		const compacted = traceOf([{ kind: "compaction" }], reqs);
		expect(compacted).toKeepCacheWarm();
		expect(() => expect(compacted).toKeepCacheWarm({ allowAfterCompaction: false })).toThrow(/request 2 \(main\)/);
		const twice = traceOf([{ kind: "compaction" }], [...reqs, used(2200, 0)]);
		expect(() => expect(twice).toKeepCacheWarm()).toThrow(/request 4 \(main\)/);
		const otherAgent = traceOf([{ kind: "compaction", agent: "child" }], reqs);
		expect(() => expect(otherAgent).toKeepCacheWarm()).toThrow(/request 2 \(main\)/);
	});

	it("says when the usage is estimated, and cannot observe without usage", () => {
		const est = traceOf([], [used(5000, 0, "main", true), used(5000, 0, "main", true)]);
		expect(() => expect(est).toKeepCacheWarm()).toThrow(/cold cache reads \(estimated usage\)/);
		const none = traceOf([], [{}, {}]);
		expect(() => expect(none).toKeepCacheWarm()).toThrow(/cannot observe: no usage on any request/);
		expect(() => expect(none).not.toKeepCacheWarm()).toThrow(/cannot observe/);
		expect(() => expect(est).toKeepCacheWarm({ agent: "x" })).toThrow(/no usage on any request of x/);
	});

	it("reads the simulated cache of a scripted run: stable passes, a changing system prompt breaks", async () => {
		const steps: StepSource[] = [
			{ toolCalls: [{ name: "search", args: { query: "a" } }] },
			{ toolCalls: [{ name: "search", args: { query: "b" } }] },
			{ text: "done" },
		];
		const runOnce = async (unstableSystem: boolean) => {
			const gw = await gateway({ responder: script(steps) });
			const docs = mcp(gw, "docs", [{ ...searchTool, handler: () => "result ".repeat(200) }]);
			await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()], unstableSystem }, "go");
			return gw.trace;
		};
		expect(await runOnce(false)).toKeepCacheWarm({ minPromptTokens: 50 });
		const unstable = await runOnce(true);
		expect(() => expect(unstable).toKeepCacheWarm({ minPromptTokens: 50 })).toThrow(
			/estimated usage\): request 1 \(main\) read 0 of/,
		);
	});
});

describe("toHaveCompacted times", () => {
	it("counts exactly when times is given", () => {
		const t = traceOf([{ kind: "compaction" }, { kind: "compaction" }]);
		expect(t).toHaveCompacted();
		expect(t).toHaveCompacted({ times: 2 });
		expect(() => expect(t).toHaveCompacted({ times: 1 })).toThrow(/expected 1 compaction\(s\), saw 2/);
		const none = traceOf([{ kind: "answer" }]);
		none.observe("events");
		expect(none).toHaveCompacted({ times: 0 });
		expect(() => expect(traceOf([{ kind: "answer" }])).toHaveCompacted({ times: 0 })).toThrow(/cannot observe/);
	});
});
