import { Container, MouseRegion, Text, type TUI, type TuiMouseEvent } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import {
	argsCompleted,
	executionStarted,
	initialToolPhase,
	phaseArgsComplete,
	phaseExecutionStarted,
	resultReceived,
} from "../src/modes/interactive/components/tool-execution/state.ts";
import { initTheme } from "../src/theme/theme.ts";

beforeAll(() => initTheme("dark"));

const ok = { content: [{ type: "text", text: "out" }], isError: false };
const bad = { content: [{ type: "text", text: "boom" }], isError: true };

describe("tool phase transitions", () => {
	it("walks streaming → pending → running → done", () => {
		const pending = argsCompleted(initialToolPhase);
		expect(pending.phase).toBe("pending");
		const running = executionStarted(pending);
		expect(running.phase).toBe("running");
		expect(resultReceived(running, ok, true)).toEqual({ phase: "running", result: ok });
		expect(resultReceived(running, ok, false)).toEqual({ phase: "done", result: ok, ran: true });
		expect(resultReceived(running, bad, false).phase).toBe("error");
	});

	it("a call that never ran can finish, and says it did not run", () => {
		const done = resultReceived(argsCompleted(initialToolPhase), bad, false);
		expect(done).toMatchObject({ phase: "error", ran: false });
		expect(phaseExecutionStarted(done)).toBe(false);
		expect(phaseArgsComplete(done)).toBe(true);
	});

	it("ignores lifecycle events that arrive after the end", () => {
		const done = resultReceived(executionStarted(initialToolPhase), ok, false);
		expect(argsCompleted(done)).toBe(done);
		expect(executionStarted(done)).toBe(done);
	});
});

function mount(definition?: unknown, args: unknown = {}) {
	const ui = { requestRender: vi.fn() } as unknown as TUI;
	return new ToolExecutionComponent("plain_tool", "c1", args, {}, definition as never, ui, process.cwd());
}

function click(row: ToolExecutionComponent): boolean {
	const regions: MouseRegion[] = [];
	const walk = (node: unknown) => {
		if (node instanceof MouseRegion) regions.push(node);
		for (const child of (node as { children?: unknown[] }).children ?? []) walk(child);
	};
	walk(row);
	const event = { type: "click", button: "left", x: 0, y: 1, width: 80, height: 3 } as unknown as TuiMouseEvent;
	return regions.some((region) => region.handleMouse(event)?.handled === true);
}

describe("ToolExecutionComponent clicks", () => {
	it("expands a running row that shows partial output", () => {
		const row = mount();
		row.setArgsComplete();
		row.markExecutionStarted();
		row.updateResult(ok, true);
		expect((row as any).expanded).toBe(false);
		expect(click(row)).toBe(true);
		expect((row as any).expanded).toBe(true);
	});

	it("expands a running row without output when call details are hidden", () => {
		const row = mount(undefined, { path: "a.ts" });
		row.markExecutionStarted();
		expect(click(row)).toBe(true);
		expect((row as any).expanded).toBe(true);
	});

	it("is a no-op when nothing is hidden", () => {
		const row = mount(undefined, {});
		row.markExecutionStarted();
		expect(click(row)).toBe(false);
		expect((row as any).expanded).toBe(false);
	});
});

describe("ToolExecutionComponent render tracking", () => {
	it("draws once per transition that changes output and not on an idle frame", () => {
		const renderCall = vi.fn((args: { path: string }) => new Text(args.path, 0, 0));
		const row = mount({ renderCall }, { path: "a.ts" });
		const parent = new Container();
		parent.addChild(row);
		const proto = ToolExecutionComponent.prototype;
		const original = proto.render;
		const render = vi.fn(function (this: ToolExecutionComponent, width: number) {
			return original.call(this, width);
		});
		proto.render = render;
		try {
			parent.render(80);
			expect(render).toHaveBeenCalledTimes(1);
			parent.render(80);
			parent.render(80);
			expect(render).toHaveBeenCalledTimes(1);

			for (const [step, change] of [
				["args complete", () => row.setArgsComplete()],
				["started", () => row.markExecutionStarted()],
				["partial result", () => row.updateResult(ok, true)],
				["expanded", () => row.setExpanded(true)],
				["final result", () => row.updateResult(ok)],
			] as const) {
				const before = render.mock.calls.length;
				change();
				parent.render(80);
				// Expanding rebuilds the display inside the frame, which signals the parent once more: it settles one frame later.
				parent.render(80);
				const settled = render.mock.calls.length;
				expect(settled - before, step).toBeLessThanOrEqual(step === "expanded" ? 2 : 1);
				expect(settled - before, step).toBeGreaterThanOrEqual(1);
				parent.render(80);
				expect(render.mock.calls.length, `${step}: idle frame`).toBe(settled);
			}

			// Repeating a transition that already happened changes nothing.
			const before = render.mock.calls.length;
			row.setArgsComplete();
			row.markExecutionStarted();
			parent.render(80);
			expect(render.mock.calls.length).toBe(before);
		} finally {
			proto.render = original;
		}
	});
});
