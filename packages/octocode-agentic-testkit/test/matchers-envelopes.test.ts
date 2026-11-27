import { describe, expect, it } from "vitest";
import { runInproc } from "../src/agents/inproc.ts";
import { toolEnvelopes } from "../src/envelopes.ts";
import { script } from "../src/gateway.ts";
import type { ChatMessage } from "../src/trace.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";
import { call, traceOf } from "./matchers-fixtures.ts";

const asks = (id: string, name: string, args: string): ChatMessage => ({
	role: "assistant",
	content: "",
	tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
});
const result = (id: string, text: string): ChatMessage => ({ role: "tool", tool_call_id: id, content: text });

describe("toolEnvelopes", () => {
	it("takes each call once although every request repeats the history", () => {
		const first = [asks("c1", "bash", '{"command":"ls"}'), result("c1", "a\nb")];
		const t = traceOf(
			[],
			[
				{ messages: first },
				{ messages: [...first, asks("c2", "read", '{"path":"x"}'), result("c2", "x".repeat(50))] },
				{ messages: [...first, asks("c3", "read", '{"path":"y"}')], agent: "child" },
			],
		);
		expect(toolEnvelopes(t)).toEqual([
			{ agent: "main", callId: "c1", name: "bash", inputChars: 16, outputChars: 3 },
			{ agent: "main", callId: "c2", name: "read", inputChars: 12, outputChars: 50 },
			{ agent: "child", callId: "c1", name: "bash", inputChars: 16, outputChars: 3 },
			{ agent: "child", callId: "c3", name: "read", inputChars: 12 },
		]);
	});
});

describe("toKeepEnvelopesUnder", () => {
	it("sees the size of every tool result the harness sent back, through the gateway", async () => {
		const gw = await gateway({
			responder: script([{ toolCalls: [{ name: "search", args: { query: "cache" } }] }, { text: "short answer" }]),
		});
		const docs = mcp(gw, "docs", [{ ...searchTool, handler: () => "r".repeat(5000) }]);
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()] }, "find it");
		expect(gw.trace).toKeepEnvelopesUnder({ toolOutputChars: 6000, toolInputChars: 100, answerChars: 100 });
		expect(() => expect(gw.trace).toKeepEnvelopesUnder({ toolOutputChars: 4000 })).toThrow(
			/search \(main, call_1\) returned 5000 chars > 4000/,
		);
		expect(() => expect(gw.trace).toKeepEnvelopesUnder({ answerChars: 5 })).toThrow(
			/answer #\d+ \(main\) 12 chars > 5/,
		);
		expect(() => expect(gw.trace).not.toKeepEnvelopesUnder({ toolOutputChars: 6000 })).toThrow(
			/expected an envelope over/,
		);
	});

	it("checks the arguments of every model tool call, including the last reply's", () => {
		const t = traceOf([call("write", { content: "z".repeat(300) })], [{ messages: [] }]);
		expect(() => expect(t).toKeepEnvelopesUnder({ toolInputChars: 200 })).toThrow(
			/#0 write \(main\) was sent 314 chars > 200/,
		);
		expect(t).toKeepEnvelopesUnder({ toolInputChars: 200, agent: "other" });
	});

	it("needs a limit and requests", () => {
		const t = traceOf([call("a")], [{ messages: [] }]);
		expect(() => expect(t).toKeepEnvelopesUnder({})).toThrow(/set toolOutputChars, toolInputChars or answerChars/);
		expect(() => expect(traceOf([call("a")])).toKeepEnvelopesUnder({ toolInputChars: 1 })).toThrow(
			/cannot observe: no requests/,
		);
		expect(() => expect(traceOf([call("a")])).not.toKeepEnvelopesUnder({ toolInputChars: 1 })).toThrow(
			/cannot observe/,
		);
	});
});
