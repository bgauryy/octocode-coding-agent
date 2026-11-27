import { describe, expect, it } from "vitest";
import { agentLoopAdapter } from "../examples/adapters/agent-loop.ts";
import { aiSdkAdapter } from "../examples/adapters/ai-sdk.ts";
import { langChainAdapter } from "../examples/adapters/langchain.ts";
import { claudeCodeAdapter, claudeCodeMissing } from "../src/adapters/claude-code/index.ts";
import { script, scripts, startGateway } from "../src/gateway.ts";
import { mockMcp, type ToolDef } from "../src/mcp.ts";
import { agentSuite } from "../src/suite.ts";
import type { ChatMessage } from "../src/trace.ts";
import { chat, gateway } from "./helpers.ts";

/* The README's code examples that are not tests elsewhere, run as written (imports aside). */

it("the harness check: Claude Code's tool round keeps its cached prefix", async (ctx) => {
	const missing = claudeCodeMissing();
	if (missing) return ctx.skip(missing);
	const gw = await startGateway({
		responder: script([
			{ toolCalls: [{ name: "Bash", args: { command: "cat a.txt", description: "read" } }] },
			{ text: "read it" },
		]),
	});
	const session = await claudeCodeAdapter().start({ gatewayUrl: gw.url, files: { "a.txt": "hello" } });
	await session.run("read a.txt");
	expect(gw.trace).toKeepEnvelopesUnder({ toolOutputChars: 20_000 });
	expect(gw.trace).toKeepStablePrefix(); // the tool round only appended to the cached prefix
	await session.close();
	await gw.close();
}, 120_000);

describe("a system turn sent as a string, then as text blocks", () => {
	const ask = async (url: string, system: unknown): Promise<void> => {
		await fetch(`${url}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "m",
				max_tokens: 9,
				messages: [
					{ role: "user", content: "hi" },
					{ role: "system", content: system },
				],
			}),
		});
	};

	it("is the same prefix: a provider reads both as one text block", async () => {
		const gw = await gateway();
		await ask(gw.url, "# Environment\ncwd: /w");
		await ask(gw.url, [{ type: "text", text: "# Environment\ncwd: /w", cache_control: { type: "ephemeral" } }]);
		expect(gw.trace).toKeepStablePrefix();
		expect(gw.trace.requests[1].usage!.cachedTokens).toBeGreaterThan(0);
	});

	it("a block with more than text (a citation) is a different prefix", async () => {
		const gw = await gateway();
		await ask(gw.url, "# Environment\ncwd: /w");
		await ask(gw.url, [{ type: "text", text: "# Environment\ncwd: /w", citations: [{ type: "char_location" }] }]);
		expect(() => expect(gw.trace).toKeepStablePrefix()).toThrow(/message-rewritten/);
	});

	it("a chat-wire rewrite of the text is still a break", async () => {
		const gw = await gateway();
		const turn = (text: string): ChatMessage[] => [
			{ role: "system", content: text },
			{ role: "user", content: "hi" },
		];
		await chat(gw.url, { model: "m", messages: turn("v1") });
		await chat(gw.url, { model: "m", messages: turn("v2") });
		expect(() => expect(gw.trace).toKeepStablePrefix()).toThrow(/message-rewritten at message 0/);
	});
});

// The README's framework snippets, as written there (the adapters imported from this package's examples).
describe("README framework snippets", () => {
	const search: ToolDef = {
		name: "search",
		description: "Search the docs",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	};

	it("an AI SDK agent searches before answering", async () => {
		const gw = await startGateway({
			responder: script([
				{ toolCalls: [{ name: "mcp__docs__search", args: { query: "parseConfig" } }] },
				{ text: "src/loader.ts" },
			]),
		});
		const docs = mockMcp({ name: "docs", trace: gw.trace, tools: [search] });
		// wire: "openai" (default) or "anthropic"
		const session = await aiSdkAdapter({ wire: "anthropic" }).start({
			gatewayUrl: gw.url,
			mcpUrls: { docs: await docs.listen() },
		});
		expect((await session.run("Where is parseConfig defined?")).answer).toBe("src/loader.ts");
		expect(gw.trace).toHaveCalledMcp("docs", "search", { args: { query: "parseConfig" }, before: "answer" });
		await session.close();
		await docs.close();
		await gw.close();
	});

	agentSuite(
		"a LangChain agent",
		{
			adapter: langChainAdapter({ systemPrompt: "Answer from the docs." }),
			gateway: {
				responder: script([
					{ toolCalls: [{ name: "mcp__docs__search", args: { query: "parseConfig" } }] },
					{ text: "It is in src/loader.ts." },
					{ text: "src/loader.ts, as I said." },
				]),
			},
			mcp: { docs: [search] },
		},
		(t) => {
			t.test("searches, then answers", async ({ run, expect }) => {
				expect((await run("Where is parseConfig defined?")).trace).toHaveCalledMcp("docs", "search", {
					before: "answer",
				});
			});
			t.test("answers the follow-up from the conversation", async ({ run, expect }) => {
				const turn = await run("Which file was it?");
				expect(turn.trace.of("model_tool_call")).toHaveLength(0);
				expect(turn.answer).toBe("src/loader.ts, as I said.");
			});
		},
	);

	it("hands the search to a researcher", async () => {
		const task = "Find every caller of parseConfig under src/";
		const gw = await startGateway({
			responder: scripts({
				main: [
					{ toolCalls: [{ name: "delegate", args: { agent: "researcher", task } }] },
					{ text: "cli.ts calls it." },
				],
				researcher: [{ text: "cli.ts calls parseConfig" }],
			}),
		});
		const session = await agentLoopAdapter({ subagents: { researcher: "Research, then report in one line." } }).start({
			gatewayUrl: gw.url,
		});
		expect((await session.run("Who calls parseConfig?")).answer).toBe("cli.ts calls it.");
		expect(gw.trace).toHaveSpawned("researcher");
		expect(gw.trace).toHaveHandedOff("main", "researcher");
		await session.close();
		await gw.close();
	});
});
