import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import { resetCapabilitiesCache, setCapabilities, Text, type TUI, type TuiMouseEvent } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashTool, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

// Small 2x2 blue JPEG image
const TINY_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	afterEach(() => {
		resetCapabilitiesCache();
		vi.useRealTimers();
	});

	test("preserves structured result data and error metadata for custom renderers", () => {
		const result: AgentToolResult & { isError: boolean } = {
			content: [{ type: "text", text: "partial failure" }],
			details: { completed: 2 },
			structuredContent: { completed: 2, failed: 1 },
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			isError: true,
			terminate: true,
		};
		const renderResult = vi.fn<NonNullable<ToolDefinition["renderResult"]>>(() => new Text("result", 0, 0));
		const component = new ToolExecutionComponent(
			"custom_tool",
			"result-data",
			{},
			{},
			{ ...createBaseToolDefinition(), renderResult },
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(result, true);
		expect(renderResult.mock.calls.at(-1)?.[0]).toEqual(result);
		component.updateResult(result);
		expect(renderResult.mock.calls.at(-1)?.[0]).toEqual(result);
	});

	// Issue #10292: the component loads the PNG transcoder itself, so this works in any TUI host.
	// Issue #8577: a replaced partial image must not resurface.
	test("converts non-PNG tool images once the transcoder loads", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const component = new ToolExecutionComponent("tool", "id", {}, {}, undefined, createFakeTui(), process.cwd());
		component.updateResult(
			{ content: [{ type: "image", data: "cGFydGlhbA==", mimeType: "image/jpeg" }], isError: false },
			true,
		);
		component.updateResult({ content: [{ type: "image", data: TINY_JPEG, mimeType: "image/jpeg" }], isError: false });

		await vi.waitFor(() => expect(component.render(120).join("\n")).toContain(";iVBORw0KGgo"));
		const rendered = component.render(120).join("\n");
		expect(rendered).not.toContain("cGFydGlhbA==");

		// Invalidation reuses the converted Image, so the Kitty image ID stays the same.
		component.invalidate();
		expect(component.render(120).join("\n")).toBe(rendered);
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("bash"),
		};

		const component = new ToolExecutionComponent(
			"bash",
			"tool-2",
			{ command: "echo README.md" },
			{},
			withBuiltInRenderers("bash", overrideDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "README.md" }], details: undefined, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("$ echo README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	// Issue #9628: keep short durations precise and make long shell durations readable.
	test.each([
		{ ms: 0, formatted: "0.0s" },
		{ ms: 4_200, formatted: "4.2s" },
		{ ms: 59_900, formatted: "59.9s" },
		{ ms: 59_999, formatted: "60.0s" },
		{ ms: 60_000, formatted: "1m 0s" },
		{ ms: 90_900, formatted: "1m 30s" },
		{ ms: 1_592_200, formatted: "26m 32s" },
		{ ms: 3_599_999, formatted: "59m 59s" },
		{ ms: 3_600_000, formatted: "1h 0m 0s" },
		{ ms: 7_384_900, formatted: "2h 3m 4s" },
	])("bash renderer formats $ms ms as $formatted while running and after completion", ({ ms, formatted }) => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-duration",
			{ command: "long-running-command" },
			{},
			createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [], isError: false }, true);

		vi.advanceTimersByTime(ms);
		component.invalidate();
		const running = stripAnsi(component.render(120).join("\n"));

		component.updateResult({ content: [], isError: false }, false);
		const completed = stripAnsi(component.render(120).join("\n"));

		vi.advanceTimersByTime(1_000);
		component.invalidate();
		expect(stripAnsi(component.render(120).join("\n"))).toBe(completed);
		expect(running).toContain(`Elapsed ${formatted}`);
		expect(completed).toContain(`Took ${formatted}`);
	});

	// #10549
	test("bash renderer shows a result's recorded duration, also for a result restored without a live start", () => {
		const render = (live: boolean): string => {
			vi.useFakeTimers();
			vi.setSystemTime(0);
			const component = new ToolExecutionComponent(
				"bash",
				"tool-bash-recorded",
				{ command: "sleep 4" },
				{},
				createBashToolDefinition(process.cwd(), { exposeSessionEnvironment: false }),
				createFakeTui(),
				process.cwd(),
			);
			if (live) {
				component.markExecutionStarted();
				component.updateResult({ content: [], isError: false }, true);
				// The wall clock jumps; the recorded duration does not.
				vi.advanceTimersByTime(3_600_000);
			}
			component.updateResult({ content: [], isError: false, durationMs: 4_200 }, false);
			return stripAnsi(component.render(120).join("\n"));
		};
		expect(render(true)).toContain("Took 4.2s");
		expect(render(false)).toContain("Took 4.2s");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-4",
			{ command: "echo hello" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\$ echo hello/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("bash"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"bash",
			"tool-4b",
			{ command: "cat notes.txt" },
			{},
			withBuiltInRenderers("bash", overrideDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("bash"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"bash",
			"tool-4c",
			{ command: "cat README.md" },
			{},
			withBuiltInRenderers("bash", overrideDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("$ cat README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createBashToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"bash",
			"tool-4d",
			{ command: "cat README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("$ cat README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createBashTool(process.cwd());
		const component = new ToolExecutionComponent(
			"bash",
			"tool-4e",
			{ command: "cat README.md" },
			{},
			{
				...createBaseToolDefinition("bash"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("shows arguments in the fallback call header", () => {
		const longValue = "x".repeat(200);
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-args",
			{ query: "octocode", long: longValue, text: "line one\nline two" },
			{},
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);

		const collapsed = stripAnsi(component.render(300).join("\n"));
		expect(collapsed).toContain('custom_tool query="octocode" long="xxx');
		expect(collapsed).toContain("...");
		expect(collapsed).not.toContain(longValue);

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(300).join("\n"));
		expect(expanded).toContain("  query: octocode");
		expect(expanded).toContain(longValue);
		const expandedLines = expanded.split("\n").map((line) => line.trimEnd());
		const textLine = expandedLines.findIndex((line) => line.endsWith("  text: line one"));
		expect(textLine).toBeGreaterThan(-1);
		expect(expandedLines[textLine + 1]).toMatch(/^\s+ {4}line two$/);
	});

	test("collapses fallback results until expanded", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		const output = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("custom_tool");
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("5 more lines");
		expect(collapsed).toContain("to expand");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("line-15");
		expect(expanded).not.toContain("more lines");
	});

	test("expands a collapsed tool result when clicked", () => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-click-expand",
			{ path: "notes.txt" },
			{},
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		const output = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: undefined, isError: false }, false);
		const width = 120;
		const lines = component.render(width);
		expect(stripAnsi(lines.join("\n"))).not.toContain("line-15");
		const resultRow = lines.findIndex((line) => stripAnsi(line).includes("notes.txt"));
		expect(resultRow).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 2,
			y: resultRow,
			screenX: 2,
			screenY: resultRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);
		expect(stripAnsi(component.render(width).join("\n"))).toContain("line-15");
	});
});
