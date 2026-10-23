import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSession } from "../../src/octocode/browser/cdp.ts";
import {
	click,
	drag,
	fillFields,
	hover,
	pressKey,
	refForText,
	settle,
	typeInto,
	waitForText,
} from "../../src/octocode/browser/input.ts";

type Page = BrowserSession["page"];
type Sent = { method: string; params: Record<string, unknown> };

/** A page whose `evaluate` returns `answer(expression)` (throwing it when it is an Error), recording every command sent. */
function fakePage(answer: (expression: string) => unknown) {
	const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
	const sent: Sent[] = [];
	const expressions: string[] = [];
	const page = {
		on: (listener: (method: string, params: Record<string, unknown>) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		send: async (method: string, params: Record<string, unknown> = {}) => {
			sent.push({ method, params });
			return {};
		},
		evaluate: async (expression: string) => {
			expressions.push(expression);
			const value = answer(expression);
			if (value instanceof Error) throw value;
			return value;
		},
		untilDialog: async <T>(work: Promise<T>) => work,
	};
	return {
		page: page as unknown as Page,
		sent,
		expressions,
		emit: (method: string, params: Record<string, unknown> = {}) => {
			listeners.forEach((listener) => {
				listener(method, params);
			});
		},
	};
}

const inOrder =
	(...values: unknown[]) =>
	() =>
		values.shift();
const mouse = (sent: Sent[]) =>
	sent
		.filter((item) => item.method === "Input.dispatchMouseEvent")
		.map(({ params }) => `${String(params.type)}@${String(params.x)},${String(params.y)}`);

afterEach(() => vi.useRealTimers());

describe("pointing at elements", () => {
	it("refuses hidden targets without invoking a DOM click", async () => {
		const { page, sent, expressions } = fakePage(() => "hidden");
		await expect(click(page, 4)).rejects.toThrow("no visible box to click");
		expect(expressions[0]).not.toContain("el.click()");
		expect(sent).toEqual([]);
	});

	it("refuses a target covered after the mouse move without pressing", async () => {
		const { page, sent } = fakePage(
			inOrder({ x: 10, y: 10, covered: "" }, { x: 20, y: 30, covered: 'div#banner "Cookies"' }),
		);
		await expect(click(page, 2)).rejects.toThrow('div#banner "Cookies" covers [2]; click was refused.');
		expect(mouse(sent)).toEqual(["mouseMoved@10,10", "mouseMoved@20,30"]);
	});

	it("refuses a target that loses its box after the move", async () => {
		const { page, sent } = fakePage(inOrder({ x: 1, y: 2, covered: "" }, "hidden"));
		await expect(click(page, 1)).rejects.toThrow("no visible box to click");
		expect(mouse(sent)).toEqual(["mouseMoved@1,2"]);
	});

	it("does not change link targets when hovering", async () => {
		const { page, expressions } = fakePage(() => ({ x: 1, y: 2, covered: "" }));
		await hover(page, 1);
		expect(expressions.join("\n")).not.toContain("link.target =");
	});

	it.each(["abort", "error"])("releases the mouse when drag ends with %s", async (failure) => {
		const controller = new AbortController();
		const { page, sent } = fakePage(() => ({ x: 1, y: 2, covered: "" }));
		const send = page.send.bind(page);
		page.send = async <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
			const result = await send<T>(method, params, signal);
			if (params?.type === "mousePressed") {
				if (failure === "abort") controller.abort(new Error("stop"));
				else throw new Error("dispatch failed");
			}
			return result;
		};
		await expect(drag(page, 1, 2, controller.signal)).rejects.toThrow();
		expect(mouse(sent).at(-1)).toBe("mouseReleased@1,2");
		expect(sent).toContainEqual({ method: "Input.setInterceptDrags", params: { enabled: false } });
	});

	it.each(["+", "Control++", "Shift++"])("presses literal plus in %s", async (combo) => {
		const { page, sent } = fakePage(() => undefined);
		await pressKey(page, combo);
		expect(sent.map(({ params }) => params.key)).toEqual(["+", "+"]);
		expect(sent[0]?.params.modifiers).toBe(combo === "+" ? 0 : combo === "Control++" ? 2 : 8);
	});

	it("refuses gone and boxless elements for click, hover and drag", async () => {
		await expect(click(fakePage(() => null).page, 3)).rejects.toThrow("No element [3] — take a new snapshot.");
		const hidden = fakePage(() => "hidden");
		await expect(hover(hidden.page, 5)).rejects.toThrow("[5] has no visible box to hover.");
		expect(hidden.expressions[0]).not.toContain("el.click()");
		await expect(drag(hidden.page, 5, 6)).rejects.toThrow("[5] has no visible box to drag.");
		const point = { x: 1, y: 1, covered: "" };
		const target = fakePage(inOrder(point, point, "hidden"));
		await expect(drag(target.page, 5, 6)).rejects.toThrow("[6] has no visible box to drop on.");
		expect(target.sent.some((item) => item.params.type === "mousePressed")).toBe(false);
	});

	it("throws when no visible element contains the text", async () => {
		await expect(refForText(fakePage(() => null).page, "Drop here")).rejects.toThrow(
			'No visible element contains "Drop here".',
		);
	});
});

describe("typing and filling", () => {
	it("refuses a gone element, a missing option and a non-text target", async () => {
		await expect(typeInto(fakePage(() => null).page, 1, "x", false)).rejects.toThrow(
			"No element [1] — take a new snapshot.",
		);
		await expect(typeInto(fakePage(() => "no-option:Red | Blue").page, 1, "Green", false)).rejects.toThrow(
			'[1] has no option "Green". Options: Red | Blue',
		);
		await expect(typeInto(fakePage(() => "no-focus").page, 1, "x", false)).rejects.toThrow(
			/\[1\] is not a text field, so typing was refused/,
		);
	});

	it("inserts text into a field (not into a select it already set), then presses Enter on submit", async () => {
		const select = fakePage(inOrder("select", true));
		await typeInto(select.page, 1, "Blue", false);
		expect(select.sent).toEqual([]);
		const field = fakePage(inOrder("field", true));
		await typeInto(field.page, 1, "hello", true);
		expect(field.sent.map((item) => `${item.method}:${String(item.params.text ?? item.params.type)}`)).toEqual([
			"Input.insertText:hello",
			"Input.dispatchKeyEvent:\r",
			"Input.dispatchKeyEvent:keyUp",
		]);
	});

	it("clicks a toggle only when its state differs, and lists the fields that failed", async () => {
		const states: Record<string, unknown> = { "0": "checked", "1": "unchecked", "2": null };
		const { page, sent } = fakePage((expression) => {
			const index = /__octoRefs \|\| \[\]\)\[(\d+)\]/.exec(expression)?.[1] ?? "";
			if (expression.includes("aria-checked")) {
				const state = states[index];
				if (index === "0") states[index] = "unchecked";
				return state;
			}
			return { x: 3, y: 3, covered: "" };
		});
		const failures = await fillFields(page, [
			{ ref: 1, value: "false" },
			{ ref: 2, value: "off" },
			{ ref: 3, value: "x" },
		]);
		expect(failures).toEqual(["[3]: No element [3] — take a new snapshot."]);
		expect(mouse(sent).filter((event) => event.startsWith("mousePressed"))).toEqual(["mousePressed@3,3"]);
	});
	it("does not submit text that the page did not retain", async () => {
		const { page, sent } = fakePage(inOrder("field", false));
		await expect(typeInto(page, 1, "rejected", true)).rejects.toThrow("did not retain");
		expect(sent.some(({ method }) => method === "Input.dispatchKeyEvent")).toBe(false);
	});

	it("reports a toggle that remains checked after clicking, including a selected radio", async () => {
		const { page } = fakePage((expression) =>
			expression.includes("aria-checked") ? "checked" : { x: 1, y: 2, covered: "" },
		);
		expect(await fillFields(page, [{ ref: 1, value: "false" }])).toEqual([
			"[1]: Toggle did not become unchecked; inspect the field before retrying.",
		]);
	});

	it("rejects unrecognized toggle values without clicking", async () => {
		const { page, sent } = fakePage(() => "checked");
		expect(await fillFields(page, [{ ref: 1, value: "typo" }])).toEqual([
			"[1]: Toggle value must be true or false.",
		]);
		expect(sent).toEqual([]);
	});

});

describe("waits that honour abort", () => {
	const timing = { probeMs: 1_000, loadMs: 1_000, quietMs: 1, domMaxMs: 1 };

	it("settle rejects with the reason of a signal aborted before it starts", async () => {
		const controller = new AbortController();
		controller.abort(new Error("stop now"));
		await expect(settle(fakePage(() => true).page, controller.signal, timing)).rejects.toThrow("stop now");
	});

	it('settle rejects with "Aborted" when aborted mid-probe without an Error reason', async () => {
		const controller = new AbortController();
		const { page, expressions } = fakePage(() => true);
		const settling = settle(page, controller.signal, timing);
		controller.abort("string reason");
		await expect(settling).rejects.toThrow(/^Aborted$/);
		expect(expressions).toEqual([]);
	});

	it("waitForText stops polling with the abort reason", async () => {
		const controller = new AbortController();
		const { page } = fakePage(() => "other text");
		controller.abort(new Error("user stopped"));
		await expect(waitForText(page, "wanted", false, 10_000, controller.signal, 1)).rejects.toThrow("user stopped");
	});

	it("waitForText treats a failed probe as unknown and times out naming the text", async () => {
		const { page, expressions } = fakePage(() => new Error("Execution context was destroyed"));
		await expect(waitForText(page, "gone soon", true, 30, undefined, 5)).rejects.toThrow(
			'Timed out after 0s waiting for "gone soon" to disappear.',
		);
		expect(expressions.length).toBeGreaterThan(1);
	});

	it("waitForText resolves undefined when a dialog interrupts the probe", async () => {
		const { page } = fakePage(() => "x");
		const blocked = Object.assign(Object.create(page) as Page, { untilDialog: async () => undefined });
		expect(await waitForText(blocked, "x", false, 1_000)).toBeUndefined();
	});
});
