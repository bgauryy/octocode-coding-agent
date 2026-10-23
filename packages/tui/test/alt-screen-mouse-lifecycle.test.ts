import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { Container, type TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function control(events: string[], capture = false) {
	return {
		invalidate() {},
		render: () => ["control"],
		handleMouse(event: TuiMouseEvent) {
			events.push(event.type);
			return {
				handled: true,
				...(event.type === "press" && capture ? { capture: true } : {}),
			};
		},
	};
}

const press = "\x1b[<0;1;1M";
const release = "\x1b[<0;1;1m";

describe("alternate-screen mouse target lifecycle", () => {
	for (const capture of [false, true]) {
		it(`does not release or click a removed ${capture ? "captured" : "pressed"} component`, async () => {
			const terminal = new VirtualTerminal(20, 2);
			const tui = new TuiAltScreen(terminal);
			const events: string[] = [];
			const target = control(events, capture);
			tui.addChild(target);
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput(press);
				assert.deepEqual(events, ["press"]);
				tui.removeChild(target);
				terminal.sendInput(release);
				assert.deepEqual(events, ["press"]);
			} finally {
				tui.stop();
			}
		});
	}

	it("does not click a child removed from a still-mounted container", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		const container = new Container();
		const events: string[] = [];
		const target = control(events, true);
		container.addChild(target);
		tui.addChild(container);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput(press);
			assert.deepEqual(events, ["press"]);
			container.removeChild(target);
			terminal.sendInput(release);
			assert.deepEqual(events, ["press"]);
		} finally {
			tui.stop();
		}
	});

	for (const mutation of ["hide", "remove"] as const) {
		it(`does not release or click a ${mutation === "hide" ? "hidden" : "removed"} overlay`, async () => {
			const terminal = new VirtualTerminal(20, 2);
			const tui = new TuiAltScreen(terminal);
			const events: string[] = [];
			const target = control(events, true);
			tui.start();
			try {
				const overlay = tui.showOverlay(target, {
					anchor: "top-left",
					width: 20,
				});
				await terminal.waitForRender();
				terminal.sendInput(press);
				assert.deepEqual(events, ["press"]);
				if (mutation === "hide") overlay.setHidden(true);
				else overlay.hide();
				terminal.sendInput(release);
				assert.deepEqual(events, ["press"]);
			} finally {
				tui.stop();
			}
		});
	}

	it("preserves a capture while its component remains mounted", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		const events: string[] = [];
		tui.addChild(control(events, true));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput(press);
			terminal.sendInput(release);
			assert.deepEqual(events, ["press", "release", "click"]);
		} finally {
			tui.stop();
		}
	});

	for (const removeOwner of [false, true]) {
		it(`${removeOwner ? "drops" : "preserves"} a forwarded capture when its wrapper is ${removeOwner ? "removed" : "mounted"}`, async () => {
			const terminal = new VirtualTerminal(20, 2);
			const tui = new TuiAltScreen(terminal);
			const events: string[] = [];
			const wrapper = new MouseRegion(control(events, true), () => undefined);
			tui.addChild(wrapper);
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput(press);
				assert.deepEqual(events, ["press"]);
				if (removeOwner) tui.removeChild(wrapper);
				terminal.sendInput(release);
				assert.deepEqual(events, removeOwner ? ["press"] : ["press", "release", "click"]);
			} finally {
				tui.stop();
			}
		});
	}
});

it("does not synthesize a click after the release handler detaches its target", async () => {
	const terminal = new VirtualTerminal(20, 2);
	const tui = new TuiAltScreen(terminal);
	const events: string[] = [];
	const target = {
		invalidate() {},
		render: () => ["control"],
		handleMouse(event: TuiMouseEvent) {
			events.push(event.type);
			if (event.type === "release") tui.removeChild(target);
			return { handled: true };
		},
	};
	tui.addChild(target);
	tui.start();
	try {
		await terminal.waitForRender();
		terminal.sendInput(press);
		terminal.sendInput(release);
		assert.deepEqual(events, ["press", "release"]);
	} finally {
		tui.stop();
	}
});
