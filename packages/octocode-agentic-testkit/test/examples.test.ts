import {
	agentLoopAdapter,
	openAiChatClient,
	type LoopCall,
	type LoopMessage,
	type ModelClient,
	type ModelTurn,
} from "../examples/adapters/agent-loop.ts";
import { aiSdkAdapter } from "../examples/adapters/ai-sdk.ts";
import { langChainAdapter } from "../examples/adapters/langchain.ts";
import { describe, expect, it } from "vitest";
import {
	agentSuite,
	mcpToolName,
	mockMcp,
	scripts,
	startGateway,
	textOf,
	type AgentAdapter,
	type ResponderContext,
	type StepSource,
	type ToolDef,
} from "../src/index.ts";

/*
 * The example adapters (examples/adapters) against a scripted gateway and a mock MCP server: offline and free. Every
 * request is header-less, as a real framework sends it, so the gateway infers each agent (`Lineage`).
 */

const SEARCH = mcpToolName("docs", "search");
const FOUND = "parseConfig is defined in src/loader.ts";

const searchTool: ToolDef = {
	name: "search",
	description: "Search the docs",
	inputSchema: {
		type: "object",
		properties: { query: { type: "string" }, limit: { type: "integer" } },
		required: ["query"],
	},
	handler: (args) => (String(args.query).includes("callers") ? "cli.ts and server.ts call parseConfig" : FOUND),
};

/** Whether any message of the request holds `text`: what a scripted step reads to prove what the agent sent. */
const sent = (ctx: ResponderContext, text: string): boolean =>
	ctx.request.messages.some((m) => textOf(m.content).includes(text));

/** The main agent's replies across the three turns of `conversationSuite`, in order. */
const CONVERSATION: StepSource[] = [
	{ toolCalls: [{ name: SEARCH, args: { query: "parseConfig" } }] },
	(ctx) => ({ text: sent(ctx, FOUND) ? "It is in src/loader.ts." : "The search returned nothing." }),
	(ctx) => ({ text: sent(ctx, FOUND) ? "You asked about parseConfig: src/loader.ts." : "I do not remember." }),
	{ toolCalls: [{ name: SEARCH, args: { query: "parseConfig changelog" } }] },
	(ctx) => ({
		toolCalls: sent(ctx, "injected error") ? [{ name: SEARCH, args: { query: "parseConfig", limit: 1 } }] : [],
		text: sent(ctx, "injected error") ? "" : "The error never reached me.",
	}),
	{ text: "Found it on the second try." },
];

type Answered = AgentAdapter<{ answer: string | null }>;

function conversationSuite(name: string, adapter: Answered): void {
	agentSuite(
		name,
		{ adapter, gateway: { responder: scripts({ main: CONVERSATION }) }, mcp: { docs: [searchTool] } },
		(t) => {
			t.test("turn 1 calls the MCP tool before it answers", async ({ run, expect }) => {
				const turn = await run("Where is parseConfig defined?");
				expect(turn.trace).toHaveCalledMcp("docs", "search", {
					args: { query: "parseConfig" },
					before: "answer",
					times: 1,
				});
				expect(turn.result.answer).toBe("It is in src/loader.ts.");
			});

			t.test("turn 2 answers from the conversation without a tool", async ({ run, expect }) => {
				const turn = await run("Which file was that again?");
				expect(turn.trace.requests).toHaveLength(1);
				expect(turn.trace.requests[0].messages.map((m) => m.role)).toEqual([
					"system",
					"user",
					"assistant",
					"tool",
					"assistant",
					"user",
				]);
				expect(turn.trace.of("model_tool_call")).toHaveLength(0);
				expect(turn.result.answer).toBe("You asked about parseConfig: src/loader.ts.");
			});

			t.test("a failing tool reaches the model, which searches again", async ({ run, expect, mcp }) => {
				mcp.docs.tool("search").failOnce("error");
				const turn = await run("Look in the changelog too.");
				expect(turn.trace.of("tool_error")).toHaveLength(1);
				expect(turn.trace).toReflect({ after: "error" });
				expect(turn.trace).toNotRetryIdentically(SEARCH);
				expect(turn.trace).toHaveCalledMcp("docs", "search", { args: { limit: 1 }, before: "answer" });
				expect(turn.result.answer).toBe("Found it on the second try.");
			});
		},
	);
}

const RESEARCHER = "You are the research sub-agent. Search, then report what you found in one line.";
const TASK = "Find every caller of parseConfig under src/";

/** One prompt the main agent delegates to a `researcher` sub-agent through its `delegate` tool. */
function delegationSuite(name: string, adapter: Answered): void {
	const responder = scripts({
		main: [
			{ toolCalls: [{ name: "delegate", args: { agent: "researcher", task: TASK } }] },
			(ctx) => ({ text: sent(ctx, "cli.ts and server.ts") ? "cli.ts and server.ts call it." : "No report." }),
		],
		researcher: [
			{ toolCalls: [{ name: SEARCH, args: { query: "parseConfig callers" } }] },
			(ctx) => ({ text: sent(ctx, "cli.ts and server.ts") ? "cli.ts and server.ts call parseConfig" : "nothing" }),
		],
	});
	agentSuite(name, { adapter, gateway: { responder }, mcp: { docs: [searchTool] } }, (t) => {
		t.test("the gateway infers the sub-agent without headers", async ({ run, expect, trace }) => {
			const turn = await run("Who calls parseConfig? Ask the researcher.");
			// Header-less requests: lineage assigned every agent, and `scripts` routed by the inferred role.
			expect(trace.probes.has("lineage")).toBe(true);
			expect(trace.requests.map((r) => r.agent)).toEqual(["main", "researcher", "researcher", "main"]);
			expect(trace).toHaveSpawned("researcher", { times: 1 });
			expect(trace).toHaveHandedOff("main", "researcher");
			expect(trace).toHaveNoOrphanAgents();
			expect(trace.agent("researcher")).toHaveCalledTool(SEARCH, { args: { query: "parseConfig callers" } });
			// The mock attributes the child's MCP call to the child: no client pins it to main.
			expect(trace.of("tool_exec").map((e) => e.agent)).toEqual(["researcher"]);
			// The child is a second model call: its own system prompt, the task as its first user message.
			const child = trace.requests[1];
			expect(textOf(child.messages[0].content)).toBe(RESEARCHER);
			expect(textOf(child.messages[1].content)).toContain(TASK);
			expect(child.tools).not.toContain("delegate");
			expect(turn.result.answer).toBe("cli.ts and server.ts call it.");
		});
	});
}

for (const wire of ["openai", "anthropic"] as const) {
	conversationSuite(`ai-sdk on the ${wire} wire`, aiSdkAdapter({ wire }));
	delegationSuite(
		`ai-sdk sub-agent on the ${wire} wire`,
		aiSdkAdapter({ wire, subagents: { researcher: RESEARCHER } }),
	);
}

conversationSuite("langchain", langChainAdapter());

conversationSuite("agent loop", agentLoopAdapter());
delegationSuite("agent loop sub-agent", agentLoopAdapter({ subagents: { researcher: RESEARCHER } }));

describe("close()", () => {
	const adapters: [string, Answered][] = [
		["ai-sdk openai", aiSdkAdapter()],
		["ai-sdk anthropic", aiSdkAdapter({ wire: "anthropic" })],
		["langchain", langChainAdapter()],
		["agent loop", agentLoopAdapter()],
	];
	for (const [name, adapter] of adapters)
		it(`${name}: aborts the run in flight and refuses the next one`, async () => {
			const gw = await startGateway({ responder: scripts({ main: [{ text: "late", delayMs: 10_000 }] }) });
			try {
				const session = await adapter.start({ gatewayUrl: gw.url });
				// Settled by its own handlers, so a failed poll leaves no unhandled rejection behind.
				const outcome = session.run("hello").then(
					() => "answered",
					(e: unknown) => e,
				);
				await expect.poll(() => gw.trace.requests.length).toBe(1);
				const started = performance.now();
				await session.close();
				expect(await outcome).toBeInstanceOf(Error);
				expect(performance.now() - started).toBeLessThan(5_000);
				await expect(session.run("again")).rejects.toThrow(/session closed/);
			} finally {
				await gw.close();
			}
		});
});

interface RecordedTurn {
	messages: LoopMessage[];
	calls: LoopCall[];
}

/** A plugged-in client, as a loop library would take its own: the default one, wrapped to record every model turn. */
function recording(inner: ModelClient, turns: RecordedTurn[]): ModelClient {
	return {
		async complete(turn: ModelTurn) {
			const reply = await inner.complete(turn);
			turns.push({ messages: [...turn.messages], calls: reply.calls });
			return reply;
		},
	};
}

describe("agent loop with a plugged-in model client", () => {
	it("sends every model turn through the client it was given", async () => {
		const gw = await startGateway({
			responder: scripts({
				main: [{ toolCalls: [{ name: SEARCH, args: { query: "parseConfig" } }] }, { text: "done" }],
			}),
		});
		const docs = mockMcp({ name: "docs", tools: [searchTool], trace: gw.trace });
		try {
			const turns: RecordedTurn[] = [];
			const client = (ctx: { gatewayUrl: string }): ModelClient =>
				recording(openAiChatClient({ baseUrl: `${ctx.gatewayUrl}/v1`, model: "scripted", apiKey: "testkit" }), turns);
			const session = await agentLoopAdapter({ client }).start({
				gatewayUrl: gw.url,
				mcpUrls: { docs: await docs.listen() },
			});
			const r = await session.run("Where is parseConfig defined?");
			await session.close();
			expect(turns.map((t) => t.calls.map((c) => c.name))).toEqual([[SEARCH], []]);
			expect(turns[1].messages.at(-1)).toEqual({
				role: "tool",
				callId: turns[0].calls[0].id,
				text: FOUND,
				isError: false,
			});
			expect(r.answer).toBe("done");
			expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "parseConfig" }, before: "answer" });
		} finally {
			await docs.close();
			await gw.close();
		}
	});
});
