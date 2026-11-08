import { beforeAll, describe, expect, test, vi } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.ts";
import { QueueListComponent } from "../src/modes/interactive/components/queue-list.ts";
import { TrustPromptComponent } from "../src/modes/interactive/components/trust-prompt.ts";
import { initTheme } from "../src/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** The arrow-key label every list used to carry: the cursor (›) already shows the list moves with the arrows. */
const ARROW_LABEL = /\u2191\u2193(?:\/\S+)? (?:navigate|move|select)\b/;

const text = (lines: string[]) => lines.map(stripAnsi).join("\n");

describe("selector key hints name actions, not the arrows", () => {
	beforeAll(() => initTheme("dark"));

	test("extension selector", () => {
		const selector = new ExtensionSelectorComponent("Pick", ["a", "b"], vi.fn(), vi.fn());
		const shown = text(selector.render(80));
		expect(shown).toMatch(/enter select \u00b7 \S+ cancel/);
		expect(shown).not.toMatch(ARROW_LABEL);
	});

	test("first-time setup", () => {
		const setup = new FirstTimeSetupComponent({ onThemePreview: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn() });
		const shown = text(setup.render(80));
		expect(shown).toMatch(/enter continue \u00b7 \S+ skip setup/);
		expect(shown).not.toMatch(ARROW_LABEL);
	});

	test("trust prompt keeps its one-key choices", () => {
		const prompt = new TrustPromptComponent({
			title: "Trust this folder?",
			body: ["Project files can run code."],
			rows: [
				{ key: "y", label: "Trust", value: true },
				{ key: "n", label: "Not now", value: false },
			],
			onCancel: vi.fn(),
			onChoose: vi.fn(),
		});
		const shown = text(prompt.render(80));
		expect(shown).toContain("y/n choose \u00b7 enter confirm");
		expect(shown).not.toMatch(ARROW_LABEL);
	});

	test("queue list: the widest hint fits, narrower terminals keep edit, delete and close", () => {
		const queue = new QueueListComponent(vi.fn(), vi.fn());
		queue.setRows([{ mode: "followUp", text: "run the tests", notes: [] }]);
		const wide = text(queue.render(100));
		expect(wide).toContain(
			"shift+\u2191\u2193 reorder \u00b7 enter edit \u00b7 s next turn \u00b7 d delete \u00b7 esc close",
		);
		expect(wide).not.toMatch(/\u2191\u2193 select/);
		const narrow = text(queue.render(40));
		expect(narrow).toContain("enter edit \u00b7 d delete \u00b7 esc close");
		expect(narrow).not.toContain("reorder");
	});
});
