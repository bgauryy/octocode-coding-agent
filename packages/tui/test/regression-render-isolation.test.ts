import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { VStack } from "../src/components/v-stack.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class Healthy implements Component {
	text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

class Throwing implements Component {
	renders = 0;
	message: string;
	constructor(message = "boom \x1b[31mred\x1b[0m\nsecond line") {
		this.message = message;
	}
	render(): string[] {
		this.renders++;
		throw new Error(this.message);
	}
	invalidate(): void {}
}

function plain(lines: string[]): string[] {
	return lines.map((line) => line.trimEnd());
}

describe("render isolation", () => {
	it("keeps a healthy sibling updating while another component throws on every frame", async () => {
		const terminal = new VirtualTerminal(60, 6);
		const tui = new TuiMainScreen(terminal);
		const reports: Array<{ error: unknown; component: Component }> = [];
		tui.onRenderError = (error, component) => reports.push({ error, component });
		const healthy = new Healthy("frame 1");
		const throwing = new Throwing();
		tui.addChild(healthy);
		tui.addChild(throwing);
		tui.start();
		try {
			await terminal.waitForRender();
			let viewport = plain(await terminal.flushAndGetViewport());
			assert.strictEqual(viewport[0], "frame 1");
			assert.strictEqual(viewport[1], "⚠ Throwing failed to render: boom red");

			for (const frame of [2, 3, 4]) {
				healthy.text = `frame ${frame}`;
				tui.requestRender();
				await terminal.waitForRender();
			}
			tui.renderNow();
			viewport = plain(await terminal.flushAndGetViewport());
			assert.strictEqual(viewport[0], "frame 4");
			assert.ok(throwing.renders >= 4, `throwing component rendered ${throwing.renders} times`);
			// One report for a repeated identical failure, not one per frame.
			assert.strictEqual(reports.length, 1);
			assert.strictEqual(reports[0]?.component, throwing);
			assert.ok(reports[0]?.error instanceof Error);
		} finally {
			tui.stop();
		}
	});

	it("writes no terminal control sequence from the error message and fits the width", async () => {
		const terminal = new VirtualTerminal(24, 4);
		const tui = new TuiMainScreen(terminal);
		tui.onRenderError = () => {};
		tui.addChild(new Throwing("\x1b]0;pwned\x07\x1b[2J a long message that does not fit"));
		tui.start();
		try {
			tui.renderNow();
			const viewport = plain(await terminal.flushAndGetViewport());
			assert.ok((viewport[0] ?? "").length <= 24);
			assert.match(viewport[0] ?? "", /^⚠ Throwing failed/);
		} finally {
			tui.stop();
		}
	});

	it("reports again after the component recovers and fails with a new error", async () => {
		const terminal = new VirtualTerminal(60, 6);
		const tui = new TuiMainScreen(terminal);
		const reports: string[] = [];
		tui.onRenderError = (error) => reports.push(error instanceof Error ? error.message : String(error));
		let fail: string | undefined = "first";
		const flaky: Component = {
			render: () => {
				if (fail) throw new Error(fail);
				return ["ok"];
			},
			invalidate: () => {},
		};
		tui.addChild(flaky);
		tui.start();
		try {
			tui.renderNow();
			tui.renderNow();
			fail = undefined;
			tui.renderNow();
			assert.strictEqual(plain(await terminal.flushAndGetViewport())[0], "ok");
			fail = "first";
			tui.renderNow();
			assert.deepStrictEqual(reports, ["first", "first"]);
		} finally {
			tui.stop();
		}
	});

	it("isolates the innermost container child, keeping its siblings inside a Box", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TuiMainScreen(terminal);
		tui.onRenderError = () => {};
		const list = new Container();
		list.addChild(new Healthy("before"));
		list.addChild(new Throwing());
		list.addChild(new Healthy("after"));
		const box = new Box(0, 0);
		box.addChild(list);
		tui.addChild(box);
		tui.start();
		try {
			tui.renderNow();
			const viewport = plain(await terminal.flushAndGetViewport());
			assert.strictEqual(viewport[0], "before");
			assert.match(viewport[1] ?? "", /Throwing failed to render/);
			assert.strictEqual(viewport[2], "after");
		} finally {
			tui.stop();
		}
	});

	it("isolates a throwing overlay and a throwing alt-screen layout leaf", async () => {
		const terminal = new VirtualTerminal(60, 6);
		const tui = new TuiAltScreen(terminal);
		tui.onRenderError = () => {};
		const healthy = new Healthy("base");
		tui.addChild(healthy);
		tui.showOverlay(new Throwing("overlay broke"), { anchor: "bottom-left", width: 50 });
		tui.start();
		try {
			tui.renderNow();
			let screen = plain(await terminal.flushAndGetViewport()).join("\n");
			assert.match(screen, /base/);
			assert.match(screen, /Throwing failed to render: overlay/);
			tui.hideOverlay();
			tui.setLayoutRoot(new VStack([new Healthy("top"), new Throwing("leaf broke"), new Healthy("bottom")]));
			tui.renderNow();
			screen = plain(await terminal.flushAndGetViewport()).join("\n");
			assert.match(screen, /top\n⚠ Throwing failed to render: leaf broke\nbottom/);
		} finally {
			// Leaving the alternate screen renders the document once more, outside the frame loop.
			tui.stop();
		}
	});

	it("appends the first report to the render error log when no handler is set", async () => {
		const logDir = mkdtempSync(join(tmpdir(), "tui-render-errors-"));
		const terminal = new VirtualTerminal(60, 6);
		const tui = new TuiMainScreen(terminal, undefined, logDir);
		tui.addChild(new Throwing("logged failure"));
		tui.start();
		try {
			tui.renderNow();
			tui.renderNow();
			const log = readFileSync(join(logDir, "octocode-tui-render-errors.log"), "utf8");
			assert.strictEqual(log.match(/logged failure/g)?.length, 1);
			assert.match(log, /Throwing/);
		} finally {
			tui.stop();
			rmSync(logDir, { recursive: true, force: true });
		}
	});

	it("still propagates a render error outside a TUI frame", () => {
		const container = new Container();
		container.addChild(new Throwing("direct"));
		assert.throws(() => container.render(20), /direct/);
	});
});
