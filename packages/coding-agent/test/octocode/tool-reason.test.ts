import fs from "node:fs";
import path from "node:path";
import { runToolCall } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, validateToolArguments } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { wrapToolDefinition } from "../../src/core/tools/tool-definition-wrapper.ts";
import { agentModes } from "../../src/octocode/agent-tool.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { Params, renameReasoning } from "../../src/octocode/files/tool/queries.ts";
import { isNativeTool, withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { callReason, withoutReason, withReason } from "../../src/octocode/shared/reason.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

type Result = { content: { type: "text"; text: string }[]; details: object };
const empty = async (..._args: unknown[]): Promise<Result> => ({ content: [], details: {} });
const tool = (name: string, execute = vi.fn(empty)) => ({
	name,
	label: name,
	description: "test",
	parameters: Type.Object({ command: Type.String() }),
	execute,
});
const validate = (definition: { name: string; parameters: unknown }, args: Record<string, unknown>) =>
	validateToolArguments(definition as never, {
		type: "toolCall",
		id: "c",
		name: definition.name,
		arguments: args as never,
	});

const run = (tool: any, args: Record<string, unknown>, beforeToolCall = vi.fn()) =>
	runToolCall(
		{ type: "toolCall", id: "c", name: tool.name, arguments: args as never },
		{
			tools: [tool],
			assistantMessage: fauxAssistantMessage("Continue"),
			context: { messages: [], tools: [tool] },
			beforeToolCall,
		},
	);

describe("the required reason on native tools", () => {
	it("adds a required reason to a native tool and strips it before the tool runs", async () => {
		const fake = fakeHost();
		const execute = vi.fn(empty);
		withNativePermissionOwners(fake.api).registerTool(tool("bash", execute));
		const registered = fake.tools.get("bash");
		expect(registered.parameters.required).toEqual(["command", "reason"]);
		expect(registered.parameters.properties.reason.description).toMatch(/^Why this call/);
		expect(validate(registered, { command: "ls", reason: "list the folder" })).toEqual({
			command: "ls",
			reason: "list the folder",
		});
		expect(() => validate(registered, { command: "ls" })).toThrow(/reason/);
		await registered.execute("c", { command: "ls", reason: "list the folder" }, undefined, undefined, {});
		expect(execute.mock.calls[0][1]).toEqual({ command: "ls" });
	});

	it("refuses MCP registrations from every server and any unreviewed native name", () => {
		const fake = fakeHost();
		const api = withNativePermissionOwners(fake.api);
		for (const name of ["mcp__octocode__localSearch", "mcp__other__thing", "unreviewed"]) {
			expect(() => api.registerTool(tool(name))).toThrow("no permission owner");
			expect(fake.tools.has(name)).toBe(false);
			expect(isNativeTool(name)).toBe(false);
		}
		expect(isNativeTool("skill")).toBe(true);
	});

	it("keeps a reason the tool declares itself, and its other hooks", async () => {
		const fake = fakeHost();
		const execute = vi.fn(empty);
		const prepareArguments = vi.fn((args: unknown) => args as never);
		const renderCall = vi.fn();
		const own = {
			...tool("file", execute),
			parameters: Type.Object({ reason: Type.Optional(Type.String()) }),
			prepareArguments,
			renderCall,
		};
		withNativePermissionOwners(fake.api).registerTool(own as never);
		const registered = fake.tools.get("file");
		expect(registered.parameters.properties).toEqual(own.parameters.properties);
		expect(registered.parameters.required).toEqual(["reason"]);
		expect(registered.prepareArguments({ reason: "kept" })).toEqual({ reason: "kept" });
		expect(prepareArguments).toHaveBeenCalledWith({ reason: "kept" });
		expect(registered.renderCall).toBe(renderCall);
		await registered.execute("c", { reason: "kept" }, undefined, undefined, {});
		expect(execute.mock.calls[0][1]).toEqual({ reason: "kept" });
	});

	it("keeps the prepareArguments and rendering of a wrapped tool", () => {
		const fake = fakeHost();
		const prepared = { command: "prepared" };
		const prepareArguments = vi.fn(() => prepared as never);
		const renderCall = vi.fn();
		withNativePermissionOwners(fake.api).registerTool({ ...tool("web"), prepareArguments, renderCall } as never);
		const registered = fake.tools.get("web");
		// The tool's own preparation runs first; the reason is settled on its result.
		expect(registered.prepareArguments({ command: "raw" })).toEqual({ command: "prepared", reason: "web prepared" });
		expect(prepareArguments).toHaveBeenCalledWith({ command: "raw" });
		expect(registered.renderCall).toBe(renderCall);
	});

	it("lets the flat agent call take a reason and hands its mode no unknown key", async () => {
		const fake = fakeHost();
		const api = withNativePermissionOwners(fake.api);
		const agent = agentModes();
		const modeExecute = vi.fn(async (..._args: unknown[]): Promise<Result> => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}));
		agent.collect(tool("coordinate", modeExecute) as never);
		agent.register(api);
		const registered = fake.tools.get("agent");
		const args = { type: "coordinate", command: "list", reason: "see who is running" };
		expect(validate(registered, args)).toEqual(args);
		expect(() => validate(registered, { type: "coordinate", command: "list" })).toThrow(/reason/);
		const result = await registered.execute("c", args, undefined, undefined, {});
		expect(result.details).toMatchObject({ agentType: "coordinate" });
		// The test mode declares no reason of its own, so the call reason stays with the call.
		expect(modeExecute.mock.calls[0][1]).toEqual({ command: "list" });
		await expect(registered.execute("c", { ...args, stray: 1 }, undefined, undefined, {})).rejects.toThrow(
			/does not take stray/,
		);
	});

	it("requires the flat agent call's reason through the tool-call pipeline", async () => {
		const fake = fakeHost();
		const api = withNativePermissionOwners(fake.api);
		const agent = agentModes();
		const modeExecute = vi.fn(empty);
		agent.collect(tool("coordinate", modeExecute) as never);
		agent.register(api);
		const registered = fake.tools.get("agent");
		const beforeToolCall = vi.fn();
		const args = { type: "coordinate", command: "list", reason: "top-level goal" };
		expect((await run(registered, args, beforeToolCall)).isError).toBe(false);
		expect(beforeToolCall.mock.calls[0][0].args.reason).toBe("top-level goal");
		expect(callReason(args)).toBe("top-level goal");
		expect(modeExecute.mock.calls[0][1]).toEqual({ command: "list" });
		// A call that leaves the reason out still runs, with one derived from its arguments.
		const missing = await run(registered, { type: "coordinate", command: "list" }, beforeToolCall);
		expect(missing.isError).toBe(false);
		expect(beforeToolCall.mock.calls[1][0].args.reason).toBe("agent list");
		expect(modeExecute).toHaveBeenCalledTimes(2);
		expect(modeExecute.mock.calls[1][1]).toEqual({ command: "list" });
	});

	it("leaves non-object parameters alone and reads only text reasons", () => {
		const union = Type.Union([Type.Object({ a: Type.String() }), Type.Object({ b: Type.String() })]);
		expect(withReason(union)).toBe(union);
		expect(withoutReason("text")).toBe("text");
		expect(callReason({ reason: "  why  " })).toBe("why");
		expect(callReason({ reason: " " })).toBeUndefined();
		expect(callReason({ reason: 3 })).toBeUndefined();
		expect(callReason({ request: { reason: 3 } })).toBeUndefined();
		expect(callReason(undefined)).toBeUndefined();
	});
});

describe("the file tool's renamed reason", () => {
	it("reads the old reasoning name, top level and per query, when no reason is given", () => {
		expect(
			renameReasoning({
				reasoning: "patch",
				queries: [
					{ type: "write", path: "a", reasoning: "old name" },
					{ type: "write", path: "b", reason: "new name", reasoning: "ignored" },
					{ type: "delete", path: "c", reason: "kept" },
				],
			}),
		).toEqual({
			reason: "patch",
			queries: [
				{ type: "write", path: "a", reason: "old name" },
				{ type: "write", path: "b", reason: "new name" },
				{ type: "delete", path: "c", reason: "kept" },
			],
		});
		expect(renameReasoning("not an object")).toBe("not an object");
		expect(renameReasoning({ patch: "x" })).toEqual({ patch: "x" });
	});

	it("still requires a call goal when neither level supplies one", () => {
		const file = { name: "file", parameters: Params };
		const change = { type: "delete", path: "a" };
		expect(() => validate(file, { queries: [change] })).toThrow(/reason/);
		expect(validate(file, { queries: [{ ...change, reason: "drop a" }], reason: "remove the old file" })).toMatchObject(
			{ reason: "remove the old file" },
		);
	});

	it("lets a change leave its reason out and reuses the call's", () => {
		const file = { name: "file", parameters: Params };
		const prepared = renameReasoning({
			reason: "clean up",
			queries: [
				{ type: "delete", path: "a" },
				{ type: "delete", path: "b", reason: "own" },
			],
		});
		expect(prepared.queries?.map((query) => query.reason)).toEqual(["clean up", "own"]);
		expect(() => validate(file, prepared)).not.toThrow();
		// Without a call reason there is nothing to reuse, and the call is refused as before.
		expect(() => validate(file, renameReasoning({ queries: [{ type: "delete", path: "a" }] }))).toThrow(/reason/);
	});

	it("executes a real write whose only call reason is on its query", async () => {
		const fake = fakeHost();
		const cwd = tmp();
		registerFileTool(withNativePermissionOwners(fake.api), new FileGuard(), fakePermission());
		const registered = fake.tools.get("file");
		const tool = wrapToolDefinition(registered, () => fakeCtx({ cwd, hasUI: false }) as never);
		const beforeToolCall = vi.fn();
		const reason = "Add the crash and resume tests";
		const outcome = await run(
			tool,
			{ queries: [{ type: "write", path: "nested.txt", content: "covered", reason }] },
			beforeToolCall,
		);
		expect(outcome).toMatchObject({ isError: false });
		expect(beforeToolCall.mock.calls[0][0].args.reason).toBe(reason);
		expect(fs.readFileSync(path.join(cwd, "nested.txt"), "utf8")).toBe("covered");

		// Left out everywhere, the reason is derived from the change's path, for the call and its query.
		const missing = await run(
			tool,
			{ queries: [{ type: "write", path: "missing.txt", content: "derived" }] },
			beforeToolCall,
		);
		expect(missing).toMatchObject({ isError: false });
		const seen = beforeToolCall.mock.calls[1][0].args;
		expect(seen.reason).toBe("file missing.txt");
		expect(seen.queries[0].reason).toBe("file missing.txt");
		expect(fs.readFileSync(path.join(cwd, "missing.txt"), "utf8")).toBe("derived");
	});
});
