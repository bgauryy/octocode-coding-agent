/**
 * Deferred MCP tools through a real Octocode session. Where the model's transport has no in-place tool changes, loading
 * a tool changes nothing in the tool list (its schema arrives as a tool result); where it does, the full definition is
 * appended once. Either way every request opens with the one before it, and the requests replayed through the real
 * adapters keep their cache prefix.
 */
import { fauxAssistantMessage, getCurrentTools, type TranscriptContext } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { expectAppend } from "../../../../ai/test/cache-matrix/compare.ts";
import { wireCase } from "../../../../ai/test/cache-matrix/wire.ts";
import { nativeCall } from "../e2e-calls.ts";
import { withMcpSession, type RecordedRequest } from "./mcp-session.ts";
import { recordings, replayAll } from "./session-wire.ts";

const LOOKUP = "mcp__docs__lookup";
const call = (args: Record<string, unknown>) =>
	fauxAssistantMessage([nativeCall(LOOKUP, args)], { stopReason: "toolUse" });

const serialized = (context: TranscriptContext, count = context.messages.length) =>
	JSON.stringify(context.messages.slice(0, count));
const extendsPrefix = (previous: TranscriptContext, next: TranscriptContext) =>
	next.messages.length > previous.messages.length &&
	serialized(next, previous.messages.length) === serialized(previous);
const everyRequestExtends = (requests: RecordedRequest[]) =>
	requests.slice(1).map((request, index) => extendsPrefix(requests[index].context, request.context));

/** The system messages after the opening one that declare `LOOKUP` again. */
const redeclarations = (requests: RecordedRequest[]) =>
	requests
		.at(-1)!
		.context.messages.slice(1)
		.filter(
			(message) =>
				message.role === "system" &&
				(message as { toolsAdded?: Array<{ name: string }> }).toolsAdded?.some((tool) => tool.name === LOOKUP),
		);
const lookupParameters = (context: TranscriptContext) =>
	JSON.stringify(getCurrentTools(context.messages).find((tool) => tool.name === LOOKUP)?.parameters);

const SCRIPT = [call({ query: "guide" }), fauxAssistantMessage("one")];

describe("a deferred MCP tool loaded in a session", () => {
	it("on a transport without in-place tool changes: the tool stays as declared and every request extends the last", async () => {
		await withMcpSession(async (s) => {
			await s.prompt("first", SCRIPT);
			await s.prompt("second", [call({ query: "api" }), fauxAssistantMessage("two")]);
			expect(s.requests).toHaveLength(4);
			expect(everyRequestExtends(s.requests)).toEqual([true, true, true]);
			// Not vacuous: the tool is declared without its schema, and loading it never adds a declaration.
			expect(lookupParameters(s.requests[0].context)).not.toContain("Title words to search for.");
			expect(redeclarations(s.requests)).toHaveLength(0);
			expect(lookupParameters(s.requests.at(-1)!.context)).toBe(lookupParameters(s.requests[0].context));
		});
	});

	it("on a transport with in-place tool changes: the definition is appended once, after the request that sent it thin", async () => {
		await withMcpSession(async (s) => {
			await s.use("native");
			await s.prompt("first", SCRIPT);
			await s.prompt("second", [call({ query: "api" }), fauxAssistantMessage("two")]);
			expect(s.requests).toHaveLength(4);
			expect(everyRequestExtends(s.requests)).toEqual([true, true, true]);
			expect(lookupParameters(s.requests[0].context)).not.toContain("Title words to search for.");
			expect(redeclarations(s.requests)).toHaveLength(1);
			expect(lookupParameters(s.requests.at(-1)!.context)).toContain("Title words to search for.");
		});
	});

	it("a refused call (missing argument) changes no tool declaration", async () => {
		await withMcpSession(async (s) => {
			await s.prompt("first", [call({ limit: 3 }), fauxAssistantMessage("retry later")]);
			await s.prompt("second", [fauxAssistantMessage("fine")]);
			expect(everyRequestExtends(s.requests)).toEqual([true, true]);
			expect(redeclarations(s.requests)).toHaveLength(0);
			expect(lookupParameters(s.requests.at(-1)!.context)).toBe(lookupParameters(s.requests[0].context));
		});
	});

	it("switching provider between prompts keeps the transcript append-only", async () => {
		await withMcpSession(async (s) => {
			await s.prompt("first", SCRIPT);
			await s.use("plain-2");
			await s.prompt("second", [fauxAssistantMessage("two")]);
			await s.use("native");
			await s.prompt("third", [fauxAssistantMessage("three")]);
			expect(everyRequestExtends(s.requests)).toEqual([true, true, true]);
		});
	});
});

describe("the session's requests through each real adapter", () => {
	it.each([
		"anthropic",
		"responses",
		"completions-explicit",
		"completions-plain",
		"codex",
		"google",
		"vertex",
		"xai",
	] as const)("%s: a load across prompts keeps the cache prefix", async (id) => {
		await withMcpSession(async (s) => {
			await s.prompt("first", SCRIPT);
			await s.prompt("second", [call({ query: "api" }), fauxAssistantMessage("two")]);
			const wires = await replayAll(
				recordings(
					s.requests.map((r) => r.context),
					s.requests.map((r) => r.options),
				),
				wireCase(id),
			);
			for (let index = 1; index < wires.length; index++) expectAppend(wireCase(id), wires[index - 1], wires[index]);
		});
	});
});
