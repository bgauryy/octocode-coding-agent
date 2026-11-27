import { describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/theme/theme.ts";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.ts";

describe("first-time setup analytics step", () => {
	it("starts on Don't share, so confirming twice keeps analytics off", () => {
		initTheme("dark");
		const onSubmit = vi.fn();
		const component = new FirstTimeSetupComponent({ onThemePreview: vi.fn(), onSubmit, onCancel: vi.fn() });
		component.handleInput("\r");
		component.handleInput("\r");
		expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ shareAnalytics: false }));
	});
});
