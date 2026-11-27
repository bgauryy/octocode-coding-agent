import { describe, expect, it } from "vitest";
import { runInproc } from "../src/agents/inproc.ts";
import { script, type StepSource } from "../src/gateway.ts";
import { gateway, mcp, searchTool } from "./helpers.ts";

async function run(steps: StepSource[]) {
	const gw = await gateway({ responder: script(steps) });
	const docs = mcp(gw, "docs", [searchTool]);
	docs.tool("search").failOnce("error");
	await runInproc({ gatewayUrl: gw.url, trace: gw.trace, mcp: [docs.client()] }, "go");
	return gw;
}
const search = (query: string): StepSource => ({ toolCalls: [{ name: "search", args: { query } }] });

describe("reflection", () => {
	it("error then answer fails toReflect", async () => {
		const gw = await run([search("a"), { text: "it worked (it did not)" }]);
		expect(() => expect(gw.trace).toReflect({ after: "error" })).toThrow(
			/answered \(event #\d+\) right after tool_error/,
		);
	});

	it("error then retry with changed args passes both matchers", async () => {
		const gw = await run([search("a"), search("b"), { text: "ok" }]);
		expect(gw.trace).toReflect({ after: "error" });
		expect(gw.trace).toNotRetryIdentically("search");
	});

	it("identical retry is caught", async () => {
		const gw = await run([search("a"), search("a"), { text: "ok" }]);
		expect(() => expect(gw.trace).toNotRetryIdentically("search")).toThrow(/retried with identical args/);
	});

	it("no error at all: cannot observe", async () => {
		const gw = await gateway({ responder: script([{ text: "x" }]) });
		await runInproc({ gatewayUrl: gw.url, trace: gw.trace }, "go");
		expect(() => expect(gw.trace).toReflect({ after: "error" })).toThrow(/cannot observe/);
	});
});
