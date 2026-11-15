import { Container, animationClock } from "@octocodeai/octocode-tui";
import type { ApplicationMessage } from "@octocodeai/octocode-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message = (text: string, complete = false): ApplicationMessage => ({
	id: "reply",
	role: "assistant",
	text,
	complete,
});
afterEach(() => vi.restoreAllMocks());

describe("streaming assistant presentation", () => {
	it("coalesces unseen deltas into one rebuild and preserves every appended character", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		const clears = vi.spyOn(Container.prototype, "clear");
		let text = "";
		for (let i = 0; i < 100; i++) {
			text += `${i},`;
			component.updateMessage(message(text), true);
		}
		expect(clears).not.toHaveBeenCalled();
		expect(stripAnsi(component.render(500).join("\n"))).toContain(text);
		expect(clears).toHaveBeenCalledTimes(1);
		component.render(500);
		expect(clears).toHaveBeenCalledTimes(1);
		component.updateMessage(message(`${text}done`, true), false);
		expect(clears).toHaveBeenCalledTimes(2);
		expect(stripAnsi(component.render(500).join("\n"))).toContain(`${text}done`);
		component.dispose();
	});

	it("flushes cancellation before the first frame and exposes current children", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent();
		component.updateMessage(message("partial response"), true);
		component.updateMessage({ ...message("partial response", true), stopReason: "aborted" }, false);
		expect(component.children.length).toBeGreaterThan(0);
		const output = stripAnsi(component.render(80).join("\n"));
		expect(output).toContain("partial response");
		expect(output).toMatch(/interrupt|abort/i);
		component.dispose();
	});

	it("does not start a pending reasoning animation during transcript disposal", () => {
		initTheme("dark");
		const subscribe = vi.spyOn(animationClock, "subscribe");
		const component = new AssistantMessageComponent(undefined, true, undefined, undefined, undefined, [], {
			requestRender: () => {},
		});
		component.updateMessage({ ...message(""), content: [{ id: "thinking", type: "thinking", text: "working" }] }, true);
		component.dispose();
		void component.children;
		expect(subscribe).not.toHaveBeenCalled();
	});
});
