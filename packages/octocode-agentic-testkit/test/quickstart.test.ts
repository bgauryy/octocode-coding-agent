// Mirrors the README quickstart: keep both in sync.
import { expect, it } from "vitest";
import { startGateway, script, mockMcp, referenceAdapter } from "../src/index.ts"; // matchers register via setupFiles

it("searches before answering", async () => {
	const gw = await startGateway({
		responder: script([{ toolCalls: [{ name: "search", args: { query: "cache" } }] }, { text: "done" }]),
	});
	const docs = mockMcp({
		name: "docs",
		trace: gw.trace,
		tools: [
			{
				name: "search",
				description: "Search",
				inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
			},
		],
	});
	const session = await referenceAdapter({ trace: gw.trace, mcp: [docs.client()] }).start({ gatewayUrl: gw.url });
	await session.run("find the cache docs");
	expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache" }, before: "answer" });
	await session.close();
	await docs.close();
	await gw.close();
});
