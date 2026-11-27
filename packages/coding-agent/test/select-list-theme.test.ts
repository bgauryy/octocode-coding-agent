import { resetCapabilitiesCache, setCapabilities } from "@octocodeai/octocode-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSelectListTheme, initTheme, theme } from "../src/theme/theme.ts";

describe("select list theme", () => {
	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
	});
	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("styles picker matches, directories and the key hint from existing theme tokens", () => {
		const list = getSelectListTheme();
		expect(list.matchHighlight?.("ab")).toBe(theme.bold(theme.fg("accent", "ab")));
		expect(list.directory?.("src/")).toBe(theme.fg("mdLink", "src/"));
		expect(list.hint?.("Esc close")).toBe(theme.fg("dim", "Esc close"));
	});
});
