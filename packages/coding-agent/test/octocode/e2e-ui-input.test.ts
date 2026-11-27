import { afterEach, describe, expect, it } from "vitest";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** Editor input flows (`!`, `!!`, `@`) through the real host on an xterm grid. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const on = (pattern: RegExp | string) => async () => {
	const text = await t!.text();
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
};

describe("user bash through the editor", () => {
	it("`!cmd` runs, shows output and is sent to the model with the next prompt", async () => {
		t = await startUi();
		await t.type("!echo bang-visible");
		t.press(KEY.enter);
		await t.until(on("bang-visible"), "command output on screen");
		t.script("noted");
		await t.type("what did it print");
		t.press(KEY.enter);
		await t.until(() => t!.requests.length === 1, "model request");
		expect(t.requests[0]).toContain("bang-visible");
	});

	it("`!!cmd` runs and shows output but is excluded from the model context", async () => {
		t = await startUi();
		await t.type("!!echo quiet-marker");
		t.press(KEY.enter);
		await t.until(on("quiet-marker"), "command output on screen");
		t.script("noted");
		await t.type("next");
		t.press(KEY.enter);
		await t.until(() => t!.requests.length === 1, "model request");
		expect(t.requests[0]).not.toContain("quiet-marker");
	});
});

describe("@ file autocomplete", () => {
	it("shows matching files, Tab inserts the path and the sent prompt carries it", async () => {
		t = await startUi({ files: { "src/widget.ts": "export const widget = 1;\n" } });
		await t.type("look at @wid");
		await t.until(on("widget.ts"), "autocomplete row");
		t.press(KEY.tab);
		await t.until(on(/@src\/widget\.ts/), "inserted path");
		t.script("seen");
		t.press(KEY.enter);
		await t.until(() => t!.requests.length === 1, "model request");
		expect(t.requests[0]).toContain("src/widget.ts");
	});
});
