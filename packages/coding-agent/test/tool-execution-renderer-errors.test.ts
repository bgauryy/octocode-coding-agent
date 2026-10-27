import { type Component, Text, type TUI } from "@octocodeai/octocode-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function definition(overrides: Partial<ToolDefinition>): ToolDefinition {
	return {
		name: "broken_tool",
		label: "broken_tool",
		description: "a tool whose renderer throws",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		...overrides,
	};
}

const ui = { requestRender: () => {} } as unknown as TUI;

function row(overrides: Partial<ToolDefinition>): ToolExecutionComponent {
	return new ToolExecutionComponent("broken_tool", "call-1", { path: "a.ts" }, {}, definition(overrides), ui, "/tmp");
}

const text = (component: Component) => stripAnsi(component.render(120).join("\n"));

describe("ToolExecutionComponent renderer failures", () => {
	beforeAll(() => initTheme("dark"));

	test("a throwing call renderer falls back to the plain call and names the error", () => {
		const component = row({
			renderCall: () => {
				throw new TypeError("call renderer exploded");
			},
		});
		const output = text(component);
		expect(output).toContain("broken_tool");
		expect(output).toContain("renderCall failed: TypeError: call renderer exploded");
	});

	test("a throwing result renderer keeps the plain output and names the error", () => {
		const component = row({
			renderCall: () => new Text("CALL", 0, 0),
			renderResult: () => {
				throw new Error("result renderer exploded");
			},
		});
		component.updateResult({ content: [{ type: "text", text: "PLAIN OUTPUT" }], isError: false });
		const output = text(component);
		expect(output).toContain("CALL");
		expect(output).toContain("PLAIN OUTPUT");
		expect(output).toContain("renderResult failed: Error: result renderer exploded");
	});

	test("a result renderer failure is shown even when the result has no text", () => {
		const component = row({
			renderCall: () => new Text("CALL", 0, 0),
			renderResult: () => {
				throw new Error("nothing to show");
			},
		});
		component.updateResult({ content: [], isError: false });
		expect(text(component)).toContain("renderResult failed: Error: nothing to show");
	});

	test("a component that throws while drawing shows plain output and names the error", () => {
		const component = row({
			renderCall: () => ({
				render: () => {
					throw new RangeError("draw exploded");
				},
				invalidate: () => {},
			}),
		});
		const output = text(component);
		expect(output).toContain("Tool renderer failed (RangeError: draw exploded); showing plain output.");
		expect(output).toContain("broken_tool");
	});

	test("the named error is sanitized and kept to one line", () => {
		const component = row({
			renderCall: () => {
				throw new Error("bad\u001b]0;title\u0007 thing\nsecond line");
			},
		});
		const raw = component.render(120).join("\n");
		expect(raw).not.toContain("\u001b]0;");
		const output = stripAnsi(raw);
		expect(output).toContain("renderCall failed: Error: bad thing");
		expect(output).not.toContain("second line");
	});

	test("a thrown non-Error value is still named", () => {
		const component = row({
			renderCall: () => {
				throw "plain string";
			},
		});
		expect(text(component)).toContain("renderCall failed: plain string");
	});
});
