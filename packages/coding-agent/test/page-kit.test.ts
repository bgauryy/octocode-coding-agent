import { setKeybindings } from "@octocodeai/octocode-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { badge, choice, legend, pageHints, positionLabel, windowList } from "../src/theme/page-kit.ts";

describe("page-kit", () => {
	beforeAll(() => setKeybindings(new KeybindingsManager()));

	it("gives every badge state a glyph and a word", () => {
		for (const state of ["ready", "attention", "broken", "off"] as const) {
			const b = badge(state);
			expect(b.glyph).not.toBe("");
			expect(b.word).not.toBe("");
			expect(b.text).toBe(`${b.glyph} ${b.word}`);
		}
		expect(badge("ready").tone).toBe("success");
		expect(badge("broken").tone).toBe("error");
		expect(() => badge("nope" as never)).toThrow(/Unknown badge state/);
	});

	it("names only the states given, once each", () => {
		expect(legend(["ready", "off", "ready"])).toBe("✓ ready  ○ off");
		expect(legend([])).toBe("");
	});

	const verbsOf = (hints: ReturnType<typeof pageHints>) =>
		hints.map((h) => `${h[0].startsWith("esc") ? "esc" : h[0]} ${h[1]}`);

	it("starts with enter, ends with esc, and says back only when nested", () => {
		const root = pageHints("list", { nested: false });
		expect(verbsOf(root)).toEqual(["enter open", "esc close"]);
		const nested = pageHints("detail", { nested: true });
		expect(verbsOf(nested)).toEqual(["enter run", "esc back"]);
		expect(pageHints("picker", { nested: true })[0][1]).toBe("select");
	});

	it("shows only the keys the row declares, between enter and esc", () => {
		const verbs = (rowKeys?: Record<string, string>) => verbsOf(pageHints("list", { nested: false, rowKeys }));
		expect(verbs()).toEqual(["enter open", "esc close"]);
		expect(verbs({ e: "edit", d: "remove" })).toEqual(["enter open", "e edit", "d remove", "esc close"]);
	});

	it("omits enter when it does nothing and joins an alias with esc", () => {
		const hints = pageHints("detail", { nested: true, enter: false, escAlias: "f2" });
		expect(hints.map((h) => h[1])).toEqual(["back"]);
		expect(hints[0][0]).toMatch(/^f2\/esc/);
	});

	it("windows a list around the selection and never past the ends", () => {
		expect(windowList(3, 1, 7)).toEqual({ start: 0, end: 3 });
		expect(windowList(20, 0, 5)).toEqual({ start: 0, end: 5 });
		expect(windowList(20, 10, 5)).toEqual({ start: 8, end: 13 });
		expect(windowList(20, 19, 5)).toEqual({ start: 15, end: 20 });
		expect(positionLabel(1, 5, 20)).toBe("1–5/20");
		expect(positionLabel(3, 3, 20)).toBe("3/20");
	});

	it("maps a picked label back to its outcome and refuses a persistent default", () => {
		const c = choice("Use model", [
			{ label: "Use for this chat", value: "chat" },
			{ label: "Set as default", value: "default", persistent: true },
		]);
		expect(c.labels).toEqual(["Use for this chat", "Set as default"]);
		expect(c.pick("Set as default")?.value).toBe("default");
		expect(c.pick(undefined)).toBeUndefined();
		expect(() => choice("x", [{ label: "Save", value: 1, persistent: true }])).toThrow(/default/);
		expect(() => choice("x", [])).toThrow(/no options/);
		expect(() =>
			choice("x", [
				{ label: "A", value: 1 },
				{ label: "A", value: 2 },
			]),
		).toThrow(/repeats/);
	});
});
