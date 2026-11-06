import { animationClock, type Component, Container, TuiMainScreen } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { toolHeader } from "../../src/octocode/shared/render.ts";
import { stopRowTimers } from "../../src/octocode/shared/render/rows.ts";
import type { ToolRow } from "../../src/octocode/shared/render/types.ts";
import { rendered, theme } from "./fake-host.ts";

class Text implements Component {
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(): string[] {
		return [this.text];
	}
	invalidate(): void {}
}

/** A running tool row drawn through the real renderer, as the transcript does. */
class RunningRow implements Component {
	readonly state = {} as ToolRow;
	private readonly ui: TuiMainScreen;
	private readonly label: string;
	constructor(ui: TuiMainScreen, label: string) {
		this.ui = ui;
		this.label = label;
	}
	render(): string[] {
		const context = {
			state: this.state,
			invalidate: () => this.ui.requestRender(),
			executionStarted: true,
			isPartial: true,
			isError: false,
			expanded: false,
		};
		return rendered(toolHeader(theme, context, "Bash", this.label)).split("\n");
	}
	invalidate(): void {}
}

beforeEach(() => animationClock.setReducedMotion(false));
afterEach(() => {
	vi.useRealTimers();
	stopRowTimers();
});

describe("a running row above the viewport", () => {
	it("ticks and spins without ever replaying the transcript", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		const terminal = new VirtualTerminal(60, 10);
		const ui = new TuiMainScreen(terminal);
		const chat = new Container();
		const older = new RunningRow(ui, "build");
		chat.addChild(older);
		for (let i = 0; i < 40; i++) chat.addChild(new Text(`history ${i}`));
		chat.addChild(new RunningRow(ui, "newest"));
		ui.addChild(chat);
		ui.start();
		ui.renderNow();
		const before = ui.renderCounters;
		for (let second = 0; second < 5; second++) {
			await vi.advanceTimersByTimeAsync(1_000);
			ui.renderNow();
		}
		const after = ui.renderCounters;
		expect(older.state.ticking).toBe(true);
		expect(older.state.tickedText).toMatch(/^\d+s$/);
		expect(after.requested).toBeGreaterThan(before.requested);
		expect(after.deferredAboveViewport).toBeGreaterThan(before.deferredAboveViewport);
		expect(after.fullRedraws).toBe(before.fullRedraws);
		ui.stop();
	});
});
