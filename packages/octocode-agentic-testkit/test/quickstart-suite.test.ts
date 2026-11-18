// Mirrors the README suite example: keep both in sync.
import { agentSuite, never, referenceAdapter, script, type ToolDef } from "../src/index.ts"; // matchers register via setupFiles

const search: ToolDef = {
	name: "search",
	description: "Search the docs",
	inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

agentSuite(
	"docs search",
	{
		adapter: ({ trace }) => referenceAdapter({ trace, conversation: true }),
		gateway: {
			responder: script([
				{ toolCalls: [{ name: "search", args: { query: "cache" } }] },
				{ text: "The cache docs are in docs/cache.md." },
				{ text: "docs/cache.md" },
			]),
		},
		mcp: { docs: [search] },
		guards: [never("delete_*")],
		runs: 3,
	},
	(t) => {
		t.test("turn 1 searches before answering", async ({ run, mcp, expect }) => {
			const turn = await run("find the cache docs");
			expect(turn.trace).toHaveCalledMcp("docs", "search", { args: { query: "cache" }, before: "answer" });
			expect(mcp.docs.tool("search")).toHaveBeenCalledTimes(1);
		});
		t.test("turn 2 answers from the conversation", async ({ run, expect }) => {
			const turn = await run("which file was that?");
			expect(turn.trace.of("model_tool_call")).toHaveLength(0);
			expect(turn.answer).toBe("docs/cache.md");
		});
	},
);
