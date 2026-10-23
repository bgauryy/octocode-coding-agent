import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentModes, agentOperation } from "../../src/octocode/agent-tool.ts";
import { completedLocalReads, snapshotLocalReads } from "../../src/octocode/shared/local-reads.ts";
import { seenFiles } from "../../src/octocode/files/reads.ts";
import { FileGuard } from "../../src/octocode/files/tool.ts";
import { shellScript } from "../../src/octocode/files/bash-jobs.ts";
import { ReadReports } from "../../src/octocode/subagents/handoff.ts";
import octocode from "../../src/octocode/index.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

const tool = "mcp__octocode__localFetch";
const output = (file: string, content: string, extra: object = {}) => ({
	results: [{ data: { path: file, content, ...extra } }],
});

describe("local MCP read evidence", () => {
	it("records complete numbered reads and restores their coverage from history", async () => {
		const cwd = tmp();
		const file = path.join(fs.realpathSync(cwd), "a.txt");
		fs.writeFileSync(file, "one\ntwo\n");
		const before = await snapshotLocalReads(tool, { queries: [{ path: file }] }, cwd);
		const localReads = await completedLocalReads(before, output(file, "1\tone\n2\ttwo\n", { totalLines: 2 }), cwd);
		expect(localReads).toHaveLength(1);
		expect(localReads[0]).toMatchObject({ file, whole: true, size: 8 });
		const guard = new FileGuard();
		for (const read of localReads) guard.record(read.file, read, !read.whole, read.lines);
		expect(guard.inspect(file, "write", file).refusal).toBeUndefined();
		const seen = seenFiles(
			[
				{
					id: "result",
					message: {
						role: "toolResult",
						toolName: tool,
						toolCallId: "call",
						timestamp: Date.now(),
						content: [{ type: "text", text: "read" }],
						details: { localReads },
					},
				},
			],
			cwd,
		);
		expect(seen.get(file)).toMatchObject({ file, id: "result" });
		expect(seen.get(file)?.partial).not.toBe(true);
	});

	it("accepts the legacy local reader's unminified content and base path", async () => {
		const cwd = fs.realpathSync(tmp());
		const file = path.join(cwd, "a.txt");
		fs.writeFileSync(file, "one\n");
		const before = await snapshotLocalReads("mcp__octocode__localGetFileContent", { queries: [{ path: file }] }, cwd);
		const result = { ...output("a.txt", "one\n", { contentView: "none", totalLines: 1 }), base: cwd };
		expect(await completedLocalReads(before, result, cwd)).toMatchObject([{ file, whole: true }]);
	});

	it("resolves configured MCP results against their root and refuses failed envelopes", async () => {
		const cwd = fs.realpathSync(tmp());
		const root = fs.realpathSync(tmp());
		const file = path.join(root, "a.txt");
		fs.writeFileSync(file, "one\n");
		const before = await snapshotLocalReads(tool, { queries: [{ path: file }] }, cwd);
		const structuredContent = { ...output("a.txt", "1\tone\n", { totalLines: 1 }), root };
		expect(await completedLocalReads(before, { content: [], structuredContent }, cwd)).toMatchObject([
			{ file, whole: true },
		]);
		expect(await completedLocalReads(before, { content: [], structuredContent, isError: true }, cwd)).toEqual([]);
	});

	it("marks a handoff report read only from verified retrieval metadata", async () => {
		const cwd = tmp();
		const file = path.join(cwd, "report.md");
		fs.writeFileSync(file, "done\n");
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(file, past, past);
		const input = { queries: [{ path: file }] };
		const before = await snapshotLocalReads(tool, input, cwd);
		const localReads = await completedLocalReads(before, output(file, "1\tdone\n", { totalLines: 1 }), cwd);
		const reports = new ReadReports();
		reports.track("child", cwd);
		reports.observe(tool, input, cwd);
		expect(reports.consume("child")).toBe(false);
		reports.track("child", cwd);
		reports.observe(tool, input, cwd, { localReads });
		expect(reports.consume("child")).toBe(true);
	});

	it("tracks separated ranges without inventing coverage of the gaps", async () => {
		const cwd = tmp();
		const file = path.join(fs.realpathSync(cwd), "a.txt");
		fs.writeFileSync(file, "one\ntwo\nthree\nfour\n");
		const before = await snapshotLocalReads(tool, { queries: [{ path: file }] }, cwd);
		const reads = await completedLocalReads(before, output(file, "1\tone\n4\tfour\n", { totalLines: 4 }), cwd);
		expect(reads.map(({ whole, lines }) => ({ whole, lines }))).toEqual([
			{ whole: false, lines: [1, 1] },
			{ whole: false, lines: [4, 4] },
		]);
	});

	it("refuses changed, failed, filtered, byte-window and unrequested reads", async () => {
		const cwd = tmp();
		const file = path.join(fs.realpathSync(cwd), "a.txt");
		fs.writeFileSync(file, "one\n");
		const before = await snapshotLocalReads(tool, { queries: [{ path: file }] }, cwd);
		for (const extra of [
			{ error: "denied" },
			{ contentView: "symbols" },
			{ selection: {} },
			{ pagination: { unit: "bytes", offset: 0, length: 2 } },
		])
			expect(await completedLocalReads(before, output(file, "1\tone\n", extra), cwd)).toEqual([]);
		expect(await completedLocalReads(new Map(), output(file, "1\tone\n"), cwd)).toEqual([]);
		fs.writeFileSync(file, "new\n");
		expect(await completedLocalReads(before, output(file, "1\tone\n", { totalLines: 1 }), cwd)).toEqual([]);
	});
});

describe("unified agent", () => {
	it("retains the selected mode's renderer for live updates", async () => {
		const fake = fakePi();
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
		modes.register(fake.pi);
		const update = vi.fn();
		await fake.tools
			.get("agent")!
			.execute("id", { type: "task", input: {} }, new AbortController().signal, update, fakeCtx({ cwd: tmp() }));
		expect(update).toHaveBeenCalledWith({ ...progress, details: { elapsed: 1, agentType: "task" } });
	});

	it("dispatches validated mode inputs and preserves cancellation and errors", async () => {
		const fake = fakePi();
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
		modes.register(fake.pi);
		expect([...fake.tools.keys()]).toEqual(["agent"]);
		const agent = fake.tools.get("agent")!;
		const signal = new AbortController().signal;
		const result = await agent.execute(
			"id",
			{ type: "external", input: { action: "list" } },
			signal,
			undefined,
			fakeCtx({ cwd: tmp() }),
		);
		expect(execute).toHaveBeenCalledWith("id", { action: "list" }, signal, undefined, expect.anything());
		expect(result).toMatchObject({ isError: true, details: { agentType: "external", aborted: false } });
		await expect(
			agent.execute(
				"id",
				{ type: "external", input: { action: "list" }, skills: ["release"] },
				signal,
				undefined,
				fakeCtx({ cwd: tmp() }),
			),
		).rejects.toThrow("inside input");
		await expect(
			agent.execute("id", { type: "task", input: {} }, signal, undefined, fakeCtx({ cwd: tmp() })),
		).rejects.toThrow("Invalid agent");
		await expect(
			agent.execute("id", { type: "external", input: { action: "spawn" } }, signal, undefined, fakeCtx({ cwd: tmp() })),
		).rejects.toThrow("Invalid agent");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("validates mode input like a directly registered tool: coercion, optional nulls and a named field", async () => {
		const fake = fakePi();
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
		modes.register(fake.pi);
		const agent = fake.tools.get("agent")!;
		const call = (input: unknown) =>
			agent.execute("id", { type: "task", input }, new AbortController().signal, undefined, fakeCtx({ cwd: tmp() }));
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
		await expect(call({ background: true })).rejects.toThrow(/Invalid agent task input[\s\S]*task/);
	});

	it("gives a mode's renderers the mode input as context.args, also for an error result", () => {
		const fake = fakePi();
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
		modes.register(fake.pi);
		const agent = fake.tools.get("agent")!;
		const args = { type: "message", input: { to: "inky" } };
		agent.renderCall(args, {} as never, { args } as never);
		// A thrown error has no agentType in its details; the call's type still selects the mode's renderer.
		agent.renderResult(
			{ content: [{ type: "text", text: "boom" }], details: {}, isError: true },
			{} as never,
			{} as never,
			{ args } as never,
		);
		expect(seen).toEqual([{ to: "inky" }, { to: "inky" }]);
	});

	it("lists the commands this session registered in /status, not a fixed set", async () => {
		const fake = fakePi();
		octocode(fake.pi, { mcp: false });
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

	it("keeps only communication modes in a child session", () => {
		vi.stubEnv("OCTOCODE_SUBAGENT", "1");
		try {
			const fake = fakePi();
			octocode(fake.pi, { mcp: false });
			expect(fake.tools.get("agent").parameters.properties.type.enum).toEqual(["coordinate", "message"]);
			for (const old of ["externalAgent", "coordinate", "sendMessage", "read", "powershell"])
				expect(fake.tools.has(old)).toBe(false);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("unwraps external input for the existing provenance policy", () => {
		expect(
			agentOperation({
				toolName: "agent",
				toolCallId: "id",
				input: { type: "external", input: { action: "prompt", text: "data" } },
			}),
		).toEqual({ toolName: "externalAgent", toolCallId: "id", input: { action: "prompt", text: "data" } });
	});
});

it("keeps shell prefixes separate across syntaxes", () => {
	expect(shellScript("echo hi", { type: "bash", commandPrefix: "export TEST=1" })).toBe("export TEST=1\necho hi");
	const script = shellScript("Write-Output hi", { type: "powershell", commandPrefix: "export TEST=1" });
	expect(script).toContain("[Console]::OutputEncoding");
	expect(script).toContain("Write-Output hi");
	expect(script).not.toContain("export TEST");
});
