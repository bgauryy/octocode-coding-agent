import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, Focusable } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputTarget implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	render(): string[] {
		return ["target"];
	}
	invalidate(): void {}
	handleInput(data: string): void {
		this.inputs.push(data);
	}
}

describe("focus lifecycle", () => {
	it("does not restore a removed base component when its overlay closes", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiMainScreen(terminal);
		const oldTarget = new InputTarget();
		const replacement = new InputTarget();
		const overlay = new InputTarget();
		tui.addChild(oldTarget);
		tui.setFocus(oldTarget);
		tui.start();
		try {
			const handle = tui.showOverlay(overlay);
			tui.removeChild(oldTarget);
			tui.addChild(replacement);
			handle.hide();
			terminal.sendInput("x");
			assert.equal(tui.getFocusedComponent(), null);
			assert.equal(oldTarget.focused, false);
			assert.deepEqual(oldTarget.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("does not redirect input from an invisible overlay to a removed base component", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiMainScreen(terminal);
		const oldTarget = new InputTarget();
		const overlay = new InputTarget();
		let visible = true;
		tui.addChild(oldTarget);
		tui.setFocus(oldTarget);
		tui.start();
		try {
			tui.showOverlay(overlay, { visible: () => visible });
			tui.removeChild(oldTarget);
			visible = false;
			terminal.sendInput("x");
			assert.equal(tui.getFocusedComponent(), null);
			assert.deepEqual(oldTarget.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("restores through nested overlays without reviving a removed base component", () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiMainScreen(terminal);
		const oldTarget = new InputTarget();
		const parent = new InputTarget();
		const child = new InputTarget();
		tui.addChild(oldTarget);
		tui.setFocus(oldTarget);
		tui.start();
		try {
			const parentHandle = tui.showOverlay(parent);
			const childHandle = tui.showOverlay(child);
			tui.removeChild(oldTarget);
			childHandle.hide();
			assert.equal(tui.getFocusedComponent(), parent);
			parentHandle.hide();
			terminal.sendInput("x");
			assert.equal(tui.getFocusedComponent(), null);
			assert.deepEqual(oldTarget.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("does not route keys into a replaced alternate-screen layout root", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const oldTarget = new InputTarget();
		const replacement = new InputTarget();
		tui.setLayoutRoot(oldTarget);
		tui.setFocus(oldTarget);
		tui.start();
		try {
			tui.setLayoutRoot(replacement);
			terminal.sendInput("x");
			assert.equal(tui.getFocusedComponent(), null);
			assert.deepEqual(oldTarget.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("tracks a focus target mounted after focus was assigned", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const oldTarget = new InputTarget();
		const replacement = new InputTarget();
		tui.setFocus(oldTarget);
		tui.setLayoutRoot(oldTarget);
		tui.start();
		try {
			await terminal.waitForRender();
			tui.setLayoutRoot(replacement);
			terminal.sendInput("x");
			assert.equal(tui.getFocusedComponent(), null);
			assert.deepEqual(oldTarget.inputs, []);
		} finally {
			tui.stop();
		}
	});
});
