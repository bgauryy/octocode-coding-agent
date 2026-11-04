import { runToolCall } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { classify, reasonPurpose } from "../../src/octocode/permission/gate/classify.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import {
	derivedReason,
	hasDerivedReason,
	reasonSchema,
	settleReason,
	withReason,
} from "../../src/octocode/shared/reason.ts";
import { fakeHost } from "./fake-host.ts";

/** `reason` first and soft-required: declared so the model sees it, settled before validation so a call never fails for it. */

const empty = async (..._args: unknown[]) => ({ content: [], details: {} });
const nested = Type.Object({
	op: Type.String(),
	completion: Type.Optional(Type.Object({ summary: Type.String() })),
	links: Type.Optional(Type.Array(Type.Object({ target: Type.String() }))),
	changes: Type.Optional(Type.Array(Type.Object({ path: Type.String(), reason: Type.Optional(Type.String()) }))),
});

const runCall = (tool: unknown, args: Record<string, unknown>, beforeToolCall = vi.fn()) =>
	runToolCall(
		{ type: "toolCall", id: "c1", name: (tool as { name: string }).name, arguments: args as never },
		{
			tools: [tool as never],
			assistantMessage: fauxAssistantMessage("Continue"),
			context: { messages: [], tools: [tool as never] },
			beforeToolCall,
		},
	);

describe("withReason", () => {
	it("puts a required reason first, ahead of a long queries array", () => {
		const schema = withReason(Type.Object({ queries: Type.Array(Type.String()), patch: Type.Optional(Type.String()) }));
		expect(Object.keys(schema.properties)).toEqual(["reason", "queries", "patch"]);
		expect(schema.required).toEqual(["queries", "reason"]);
	});

	it("keeps a tool's own reason definition but moves it first and requires it", () => {
		const own = Type.String({ description: "Why history is needed" });
		const schema = withReason(Type.Object({ query: Type.String(), reason: Type.Optional(own) }));
		expect(Object.keys(schema.properties)).toEqual(["reason", "query"]);
		expect(schema.properties.reason).toEqual(own);
		expect(schema.required).toEqual(["query", "reason"]);
	});

	it("returns parameters that already start with a required reason unchanged", () => {
		const first = Type.Object({ reason: reasonSchema(), query: Type.String() });
		expect(withReason(first)).toBe(first);
	});

	it("adds no nested reason slot to object arguments", () => {
		const schema = withReason(nested);
		expect(schema.properties.completion).toBe(nested.properties.completion);
		expect(schema.properties.links).toBe(nested.properties.links);
	});
});

describe("derivedReason", () => {
	it("names the tool and its most telling argument", () => {
		expect(derivedReason("bash", { command: "ls -la" })).toBe("bash ls -la");
		expect(derivedReason("web", { query: "vitest" })).toBe("web vitest");
		expect(derivedReason("file", { queries: [{ type: "edit", path: "src/a.ts" }] })).toBe("file src/a.ts");
	});

	it("falls back to the tool name alone, never empty", () => {
		expect(derivedReason("compact", {})).toBe("compact");
		expect(derivedReason("backlog", undefined)).toBe("backlog");
	});

	it("never repeats a URL credential or a secret", () => {
		expect(derivedReason("web", { url: "https://user:pass@example.com/x" })).toBe("web https://example.com/x");
	});

	it("recognizes only its own text as derived", () => {
		const input = { command: "ls" };
		expect(hasDerivedReason("bash", { ...input, reason: "bash ls" })).toBe(true);
		expect(hasDerivedReason("bash", { ...input, reason: "list the folder" })).toBe(false);
		expect(hasDerivedReason("bash", input)).toBe(false);
	});
});

describe("settleReason", () => {
	it("keeps a stated reason and fills nothing", () => {
		const args = { op: "list", reason: "see the board" };
		expect(settleReason(args, "backlog", nested)).toBe(args);
	});

	it("fills a missing, blank or non-text reason", () => {
		for (const reason of [undefined, "", "   ", 3, null]) {
			const settled = settleReason({ op: "list", reason } as never, "backlog", nested) as { reason: string };
			expect(settled.reason).toBe("backlog");
		}
	});

	it("lifts a nested reason before deriving one", () => {
		const args = { op: "x", changes: [{ path: "a" }, { path: "b", reason: "second" }] };
		expect(settleReason(args, "file", nested)).toMatchObject({ reason: "second" });
	});

	it("strips a nested reason the tool does not declare, after lifting it", () => {
		const args = {
			op: "update",
			completion: { summary: "done", reason: "why" },
			links: [{ target: "t", reason: "r" }],
		};
		const settled = settleReason(args, "backlog", nested) as Record<string, unknown>;
		expect(settled.reason).toBe("why");
		expect(settled.completion).toEqual({ summary: "done" });
		expect(settled.links).toEqual([{ target: "t" }]);
		expect(args.completion).toEqual({ summary: "done", reason: "why" });
	});

	it("keeps a nested reason the tool declares", () => {
		const args = { op: "x", reason: "call", changes: [{ path: "a", reason: "own" }] };
		expect(settleReason(args, "file", nested)).toBe(args);
	});

	it("leaves parameters without object properties and non-object arguments alone", () => {
		const union = Type.Union([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]);
		const args = { a: "x" };
		expect(settleReason(args, "web", union)).toBe(args);
		expect(settleReason("text", "web", nested)).toBe("text");
	});
});

describe("a native call without a reason", () => {
	const register = () => {
		const fake = fakeHost();
		const execute = vi.fn(empty);
		withNativePermissionOwners(fake.api).registerTool({
			name: "bash",
			label: "bash",
			description: "test",
			parameters: Type.Object({ command: Type.String() }, { additionalProperties: false }),
			execute,
		} as never);
		return { tool: fake.tools.get("bash"), execute };
	};

	it("declares reason first and required, yet runs with a derived reason the permission card shows", async () => {
		const { tool, execute } = register();
		expect(Object.keys(tool.parameters.properties)[0]).toBe("reason");
		expect(tool.parameters.required).toContain("reason");

		const beforeToolCall = vi.fn();
		const outcome = await runCall(tool, { command: "ls -la" }, beforeToolCall);
		expect(outcome.isError).toBe(false);
		const input = beforeToolCall.mock.calls[0][0].args;
		expect(input).toEqual({ command: "ls -la", reason: "bash ls -la" });
		// The tool itself never sees the reason it did not declare.
		expect(execute.mock.calls[0][1]).toEqual({ command: "ls -la" });

		const request = classify({ toolName: "bash", toolCallId: "c1", input } as never, { cwd: process.cwd() });
		expect(request).toMatchObject({ purpose: "bash ls -la", reasonDerived: true });
	});

	it("keeps the model's words and does not mark them derived", async () => {
		const { tool } = register();
		const beforeToolCall = vi.fn();
		await runCall(tool, { command: "ls", reason: "list the folder" }, beforeToolCall);
		const input = beforeToolCall.mock.calls[0][0].args;
		expect(input.reason).toBe("list the folder");
		expect(reasonPurpose({ toolName: "bash", input })).toEqual({ purpose: "list the folder" });
	});

	it("runs with a blank reason too", async () => {
		const { tool } = register();
		const beforeToolCall = vi.fn();
		const outcome = await runCall(tool, { command: "pwd", reason: "  " }, beforeToolCall);
		expect(outcome.isError).toBe(false);
		expect(beforeToolCall.mock.calls[0][0].args.reason).toBe("bash pwd");
	});

	it("still gives the permission card a purpose when the input reached it without one", () => {
		expect(reasonPurpose({ toolName: "bash", input: { command: "ls" } })).toEqual({
			purpose: "bash ls",
			reasonDerived: true,
		});
		expect(reasonPurpose({ toolName: "steps", input: { op: "list" } })).toEqual({
			purpose: "steps",
			reasonDerived: true,
		});
		// An MCP tool takes no native reason, so nothing is made up for it.
		expect(reasonPurpose({ toolName: "mcp__octocode__localSearch", input: {} })).toEqual({});
	});

	it("drops a nested reason from an object argument before validation, so strict arguments pass", async () => {
		const fake = fakeHost();
		const execute = vi.fn(empty);
		withNativePermissionOwners(fake.api).registerTool({
			name: "backlog",
			label: "backlog",
			description: "test",
			parameters: Type.Object(
				{
					op: Type.String(),
					completion: Type.Optional(Type.Object({ summary: Type.String() }, { additionalProperties: false })),
				},
				{ additionalProperties: false },
			),
			execute,
		} as never);
		const beforeToolCall = vi.fn();
		const outcome = await runCall(
			fake.tools.get("backlog"),
			{ op: "update", completion: { summary: "done", reason: "close it" } },
			beforeToolCall,
		);
		expect(outcome.isError).toBe(false);
		expect(beforeToolCall.mock.calls[0][0].args).toEqual({
			op: "update",
			completion: { summary: "done" },
			reason: "close it",
		});
		expect(execute.mock.calls[0][1]).toEqual({ op: "update", completion: { summary: "done" } });
	});
});
