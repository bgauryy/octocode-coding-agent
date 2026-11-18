import { Container, getKeybindings, setKeybindings } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/theme/theme.ts";
import {
	LongResponse,
	RESPONSE_HEAD_LINES,
	RESPONSE_TAIL_LINES,
	RESPONSE_FOLD_THRESHOLD,
} from "../src/modes/interactive/components/long-response.ts";

function source(count: number) {
	let rows = Array.from({ length: count }, (_, i) => `row-${i}`);
	return {
		render: () => rows,
		invalidate() {},
		append: (row: string) => {
			rows = [...rows, row];
		},
	};
}

describe("long response", () => {
	const previousKeybindings = getKeybindings();
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		setKeybindings(previousKeybindings);
		initTheme("dark");
	});
	it("keeps unchanged folded rows stable through the transcript container", () => {
		const message = new AssistantMessageComponent();
		message.updateMessage({
			id: "long-reply",
			role: "assistant",
			text: Array.from({ length: 150 }, (_, i) => `paragraph ${i}`).join("\n\n"),
			complete: true,
		});
		const transcript = new Container();
		transcript.addChild(message);
		const rows = transcript.render(80);
		expect(rows.join("\n")).toContain("lines hidden");
		expect(transcript.render(80)).toBe(rows);
	});
	it("reuses folded rows until content, width, keybinding or invalidation changes", () => {
		const content = source(150);
		const response = new LongResponse(content, false, () => {});
		const folded = response.render(80);
		expect(response.render(80)).toBe(folded);
		response.setExpanded(true);
		expect(response.render(80)).toBe(content.render());
		response.setExpanded(false);
		expect(response.render(80)).toBe(folded);

		const narrow = response.render(15);
		expect(narrow).not.toBe(folded);
		expect(narrow.length).toBeGreaterThan(folded.length);
		expect(response.render(15)).toBe(narrow);
		content.append("newest");
		const appended = response.render(80);
		expect(appended.at(-1)).toBe("newest");
		expect(appended).not.toBe(folded);

		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
		const rebound = response.render(80);
		expect(rebound.join("\n")).toContain("ctrl+e");
		expect(rebound).not.toBe(appended);
		expect(response.render(80)).toBe(rebound);
		initTheme("light");
		response.invalidate();
		const themed = response.render(80);
		expect(themed).not.toBe(rebound);
		expect(response.render(80)).toBe(themed);
	});
	it("leaves responses at and below the threshold unchanged", () => {
		for (const n of [RESPONSE_FOLD_THRESHOLD - 1, RESPONSE_FOLD_THRESHOLD]) {
			const content = source(n);
			expect(new LongResponse(content, false, () => {}).render(80)).toEqual(content.render());
		}
	});
	it("toggles a foldable response on left click and reports local state", () => {
		const states: boolean[] = [];
		const response = new LongResponse(source(121), false, (expanded) => states.push(expanded));
		response.render(80);
		const click = {
			type: "click",
			button: "left",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 80,
			height: 61,
			shift: false,
			alt: false,
			ctrl: false,
		} as const;
		expect(response.handleMouse(click)).toEqual({ handled: true });
		expect(response.render(80)).toHaveLength(121);
		response.handleMouse(click);
		expect(states).toEqual([true, false]);
	});
	it("folds rendered rows and restores them without changing the source", () => {
		const content = source(RESPONSE_FOLD_THRESHOLD + 1);
		const response = new LongResponse(content, false, () => {});
		const folded = response.render(80);
		expect(folded.slice(0, RESPONSE_HEAD_LINES)).toEqual(content.render().slice(0, RESPONSE_HEAD_LINES));
		expect(folded.slice(-RESPONSE_TAIL_LINES)).toEqual(content.render().slice(-RESPONSE_TAIL_LINES));
		expect(folded.join("\n")).toContain(
			`${content.render().length - RESPONSE_HEAD_LINES - RESPONSE_TAIL_LINES} lines hidden`,
		);
		response.setExpanded(true);
		expect(response.render(80)).toEqual(content.render());
		response.setExpanded(false);
		expect(response.render(80)).toEqual(folded);
		content.append("newest");
		expect(response.render(10).at(-1)).toBe("newest");
	});
});
