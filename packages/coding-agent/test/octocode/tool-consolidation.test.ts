import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentModes, agentOperation } from "../../src/octocode/agent-tool.ts";
import { shellScript } from "../../src/octocode/files/bash-jobs/shell.ts";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

describe("unified agent", () => {
	it("retains the selected mode's renderer for live updates", async () => {
		const fake = fakeHost();
		const modes = agentModes();
		const progress = { content: [{ type: "text" as const, text: "working" }], details: { elapsed: 1 } };
		modes.collect({
			name: "agent",
			label: "Task",
			description: "Task",
			parameters: Type.Object({}),
			execute: async (_id, _input, _signal, update) => {
				update?.(progress);
				return progress;
			},
		});
		modes.register(fake.api);
		const update = vi.fn();
		await fake.tools
			.get("agent")!
			.execute("id", { type: "task" }, new AbortController().signal, update, fakeCtx({ cwd: tmp() }));
		expect(update).toHaveBeenCalledWith({ ...progress, details: { elapsed: 1, agentType: "task" } });
	});

	it("dispatches validated mode inputs and preserves cancellation and errors", async () => {
		const fake = fakeHost();
		const modes = agentModes();
		const execute = vi.fn(async (_id, _input, signal) => ({
			content: [{ type: "text" as const, text: "failed" }],
			isError: true,
			details: { aborted: signal.aborted },
		}));
		modes.collect({
			name: "externalAgent",
			label: "external",
			description: "External",
			parameters: Type.Object({ action: Type.Literal("list") }),
			execute,
		});
		modes.register(fake.api);
		expect([...fake.tools.keys()]).toEqual(["agent"]);
		const agent = fake.tools.get("agent")!;
		const signal = new AbortController().signal;
		const result = await agent.execute(
			"id",
			{ type: "external", externalAction: "list" },
			signal,
			undefined,
			fakeCtx({ cwd: tmp() }),
		);
		expect(execute).toHaveBeenCalledWith("id", { action: "list" }, signal, undefined, expect.anything());
		expect(result).toMatchObject({ isError: true, details: { agentType: "external", aborted: false } });
		await expect(
			agent.execute(
				"id",
				{ type: "external", externalAction: "list", skills: ["release"] },
				signal,
				undefined,
				fakeCtx({ cwd: tmp() }),
			),
		).rejects.toThrow("agent type external does not take skills");
		await expect(agent.execute("id", { type: "task" }, signal, undefined, fakeCtx({ cwd: tmp() }))).rejects.toThrow(
			"Unknown agent type task",
		);
		await expect(
			agent.execute("id", { type: "external", externalAction: "spawn" }, signal, undefined, fakeCtx({ cwd: tmp() })),
		).rejects.toThrow("Invalid agent external call");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("validates mode input like a directly registered tool: coercion, optional nulls and a named field", async () => {
		const fake = fakeHost();
		const modes = agentModes();
		const execute = vi.fn(async (_id, input) => ({
			content: [{ type: "text" as const, text: "ok" }],
			details: { input },
		}));
		modes.collect({
			name: "agent",
			label: "Task",
			description: "Task",
			parameters: Type.Object({ task: Type.String(), background: Type.Optional(Type.Boolean()) }),
			execute,
		});
		modes.register(fake.api);
		const agent = fake.tools.get("agent")!;
		const call = (fields: Record<string, unknown>) =>
			agent.execute(
				"id",
				{ type: "task", ...fields },
				new AbortController().signal,
				undefined,
				fakeCtx({ cwd: tmp() }),
			);
		await call({ task: "a", background: "true" });
		expect(execute).toHaveBeenLastCalledWith(
			"id",
			{ task: "a", background: true },
			expect.anything(),
			undefined,
			expect.anything(),
		);
		await call({ task: "b", background: null });
		expect(execute).toHaveBeenLastCalledWith("id", { task: "b" }, expect.anything(), undefined, expect.anything());
		await expect(call({ background: true })).rejects.toThrow(/Invalid agent task call[\s\S]*task/);
	});

	it("gives a mode's renderers its own arguments as context.args, flat or from an old envelope, also for an error", () => {
		const fake = fakeHost();
		const modes = agentModes();
		const seen: unknown[] = [];
		const component = { render: () => [], invalidate() {} } as never;
		modes.collect({
			name: "sendMessage",
			label: "Message",
			description: "Message",
			parameters: Type.Object({ to: Type.String() }),
			execute: async () => ({ content: [], details: {} }),
			renderCall: (_args, _theme, context) => (seen.push(context.args), component),
			renderResult: (_result, _options, _theme, context) => (seen.push(context.args), component),
		});
		modes.register(fake.api);
		const agent = fake.tools.get("agent")!;
		// Sessions recorded before the flat fields hold the `{type, input}` envelope: they still render.
		for (const args of [
			{ type: "message", to: "inky" },
			{ type: "message", input: { to: "inky" } },
		]) {
			agent.renderCall(args, {}, { args });
			// A thrown error has no agentType in its details; the call's type still selects the mode's renderer.
			agent.renderResult({ content: [{ type: "text", text: "boom" }], details: {}, isError: true }, {}, {}, { args });
		}
		expect(seen).toEqual([{ to: "inky" }, { to: "inky" }, { to: "inky" }, { to: "inky" }]);
		// An old `models` call has no mode now: its result renders as its text.
		const old = { type: "models", input: { query: "opus" } };
		const row = agent.renderResult(
			{ content: [{ type: "text", text: "listing" }], details: { agentType: "models" } },
			{},
			{},
			{ args: old },
		);
		expect(row.render(80).join("\n")).toContain("listing");
		expect(agent.renderCall(old, {}, { args: old }).render(80).join("\n")).toContain("Agent models");
	});

	it("lists the commands this session registered in /status, not a fixed set", async () => {
		const fake = fakeHost();
		await octocode(fake.api);
		const ctx = fakeCtx({ cwd: tmp() });
		await fake.commands.get("status").handler("", ctx);
		const line = ctx.ui.notes
			.map((note: { message: string }) => note.message)
			.join("\n")
			.split("\n")
			.find((text: string) => text.startsWith("Commands: "));
		const native = [...fake.commands.keys()].filter((name) => !["octocode"].includes(name));
		for (const name of [...native, "mcp"]) expect(line).toContain(`/${name}`);
	});

	it("keeps only communication modes in a child without an installed runner", async () => {
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		vi.stubEnv("PATH", tmp());
		try {
			const fake = fakeHost();
			await octocode(fake.api);
			expect(fake.tools.get("agent").parameters.properties.type.enum).toEqual(["coordinate", "message"]);
			expect(fake.tools.has("models")).toBe(false);
			for (const old of ["externalAgent", "coordinate", "sendMessage", "read", "powershell"])
				expect(fake.tools.has(old)).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("gives domain policy each type's tool name and own arguments, flat or from an old envelope", () => {
		const op = (input: Record<string, unknown>) => agentOperation({ toolName: "agent", toolCallId: "id", input });
		expect(
			op({ type: "external", externalAction: "prompt", connection: "r", promptText: "data", reason: "ask" }),
		).toEqual({
			toolName: "externalAgent",
			toolCallId: "id",
			input: { action: "prompt", id: "r", text: "data", reason: "ask" },
		});
		expect(op({ type: "coordinate", action: "stop", subagent: "kid", joinGoal: "g" })).toMatchObject({
			toolName: "coordinate",
			input: { action: "stop", id: "kid", goal: "g" },
		});
		expect(op({ type: "task", task: "t", profile: "reviewer" })).toMatchObject({
			toolName: "agent",
			input: { task: "t", profile: "reviewer" },
		});
		expect(op({ type: "message", to: "parent", message: "m" })).toMatchObject({
			toolName: "sendMessage",
			input: { to: "parent", message: "m" },
		});
		expect(op({ type: "external", input: { action: "prompt", text: "data" } })).toMatchObject({
			toolName: "externalAgent",
			input: { action: "prompt", text: "data" },
		});
		// No mode: the call stays the public `agent` call.
		expect(op({ type: "models" })).toMatchObject({ toolName: "agent" });
	});
});

it("keeps shell prefixes separate across syntaxes", () => {
	expect(shellScript("echo hi", { type: "bash", commandPrefix: "export TEST=1" })).toBe("export TEST=1\necho hi");
	const script = shellScript("Write-Output hi", { type: "powershell", commandPrefix: "export TEST=1" });
	expect(script).toContain("[Console]::OutputEncoding");
	expect(script).toContain("Write-Output hi");
	expect(script).not.toContain("export TEST");
});
