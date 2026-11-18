import { animationClock, type Component } from "@octocodeai/octocode-tui";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useClock } from "../src/clock.ts";
import { Legacy } from "../src/legacy.tsx";
import { RenderSignalSource } from "../src/render-signal.ts";

afterEach(() => {
	vi.useRealTimers();
});

function Ticker({ active }: { active: boolean }) {
	const now = useClock(50, { active });
	return <Text>{String(now)}</Text>;
}

describe("useClock", () => {
	it("subscribes to the shared clock only while active, so an idle screen keeps the clock stopped", () => {
		const { rerender, unmount } = render(<Ticker active={false} />);
		expect(animationClock.isRunning()).toBe(false);
		rerender(<Ticker active />);
		expect(animationClock.isRunning()).toBe(true);
		rerender(<Ticker active={false} />);
		expect(animationClock.isRunning()).toBe(false);
		unmount();
	});

	it("advances with the clock", async () => {
		const { lastFrame, unmount } = render(<Ticker active />);
		const first = lastFrame();
		await vi.waitFor(() => expect(lastFrame()).not.toBe(first), { timeout: 1000 });
		unmount();
	});
});

describe("Legacy", () => {
	it("shows a component's rows with ANSI kept and paints again on each signal", async () => {
		let label = "one";
		const widths: number[] = [];
		const component: Component = {
			render: (width) => {
				widths.push(width);
				return [`\x1b[31m${label}\x1b[39m`, "second"];
			},
			invalidate: () => {},
		};
		const signal = new RenderSignalSource();
		const { lastFrame } = render(<Legacy component={component} signal={signal} width={30} />);
		expect(lastFrame()).toBe("\x1b[31mone\x1b[39m\nsecond");
		label = "two";
		expect(lastFrame()).toContain("one");
		signal.notify();
		await vi.waitFor(() => expect(lastFrame()).toContain("two"));
		expect(widths.every((width) => width === 30)).toBe(true);
	});
});
