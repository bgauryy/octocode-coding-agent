import fs from "node:fs";
import {
	fauxAssistantMessage,
	getCurrentSystemMessage,
	getCurrentTools,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { nativeCall } from "./e2e-calls.ts";
import { baseEnv, fixture, scriptedSession, withEnv } from "./agent-context/capture.ts";

/**
 * The main session carries the built-in browser server with every tool on demand: its first request lists the tools by
 * name and trigger in the cached `mcps` block and declares none; a first call declares the tool after the cached
 * prompt, so the earlier system message and tool declarations stay byte-identical. The scripted model never reaches
 * Chrome: `schema` answers without connecting to it, and the headless session denies the ask for `open`.
 */
const browserTools = (context: TranscriptContext) =>
	getCurrentTools(context.messages).filter((tool) => tool.name.startsWith("mcp__browser__"));

async function run(calls: ReturnType<typeof nativeCall>[]) {
	const fx = fixture();
	try {
		return await withEnv(baseEnv(fx), async () => {
			const { session, faux, end } = await scriptedSession(fx, {});
			const seen: TranscriptContext[] = [];
			const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
				seen.push(structuredClone(context));
				return reply;
			};
			try {
				faux.setResponses([
					...calls.map((call) => record(fauxAssistantMessage([call], { stopReason: "toolUse" }))),
					record(fauxAssistantMessage("done")),
				]);
				await session.prompt("look at the page");
			} finally {
				await end();
			}
			return seen;
		});
	} finally {
		fs.rmSync(fx.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

describe("the main session's browser tools", () => {
	it("are listed on demand in the first request, declared after a first call, and leave the earlier prefix untouched", async () => {
		const contexts = await run([nativeCall("mcp__browser__schema", {})]);
		expect(contexts).toHaveLength(2);
		const [first, second] = contexts;
		expect(browserTools(first)).toEqual([]);
		const system = JSON.stringify(getCurrentSystemMessage(first.messages));
		expect(system).toContain('<mcp name=\\"browser\\" tools=\\"mcp__browser__*\\">');
		for (const tool of ["open", "run", "schema", "cdp"]) expect(system).toContain(`- ${tool}:`);
		expect(browserTools(second).map((tool) => tool.name)).toContain("mcp__browser__schema");
		// The system message and every tool declared before the call are the same bytes in the next request.
		expect(JSON.stringify(second.messages[0])).toBe(JSON.stringify(first.messages[0]));
		const before = getCurrentTools(first.messages);
		expect(JSON.stringify(getCurrentTools(second.messages).slice(0, before.length))).toBe(JSON.stringify(before));
		expect(JSON.stringify(second.messages.slice(0, first.messages.length))).toBe(JSON.stringify(first.messages));
	});

	it("ask before a call that needs browser control, which a headless session denies", async () => {
		const contexts = await run([nativeCall("mcp__browser__open", { attach: true })]);
		const result = JSON.stringify(contexts[1].messages.filter((message) => message.role === "toolResult"));
		expect(result).toMatch(/permission|denied|browser\.control|approval/i);
	});
});
