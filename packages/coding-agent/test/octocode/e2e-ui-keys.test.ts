import { afterEach, describe, expect, it } from "vitest";
import { hang, KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** Key-driven flows through the real interactive host, drawn on an xterm grid; only the model is scripted. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Esc aborts a running turn", () => {
	it("interrupts the stream, leaves the editor usable and records the abort", async () => {
		t = await startUi();
		t.script(hang());
		await t.type("work");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming, "turn to start");
		await t.until(async () => /interrupt/i.test(await t!.text()), "interrupt hint on screen");
		t.press(KEY.esc);
		await t.until(() => !t!.host.session.isStreaming, "turn to stop");
		const messages = t.host.session.messages as Array<{ role: string; stopReason?: string }>;
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		await t.until(
			async () => !/to interrupt|interrupt$/i.test((await t!.text()).split("\n").slice(-8).join("\n")),
			"idle",
		);
		t.script("second answer");
		await t.type("again");
		t.press(KEY.enter);
		await t.until(async () => (await t!.text()).includes("second answer"), "next turn answer on screen");
	});
});

describe("Ctrl+C and Ctrl+D", () => {
	it("a single Ctrl+C clears the draft and does not exit", async () => {
		t = await startUi();
		await t.type("draft text");
		expect(await t.text()).toContain("draft text");
		t.press(KEY.ctrlC);
		await sleep(150);
		expect(await t.text()).not.toContain("draft text");
		expect(t.shutdowns).toBe(0);
	});

	it("two Ctrl+C within 500 ms exit", async () => {
		t = await startUi();
		t.press(KEY.ctrlC);
		t.press(KEY.ctrlC);
		await t.until(() => t!.shutdowns === 1, "shutdown");
	});

	it("two slow Ctrl+C presses do not exit", async () => {
		t = await startUi();
		t.press(KEY.ctrlC);
		await sleep(650);
		t.press(KEY.ctrlC);
		await sleep(200);
		expect(t.shutdowns).toBe(0);
	});

	it("Ctrl+D exits only on an empty editor", async () => {
		t = await startUi();
		await t.type("x");
		t.press(KEY.ctrlD);
		await sleep(200);
		expect(t.shutdowns).toBe(0);
		t.press(KEY.ctrlC);
		await sleep(100);
		t.press(KEY.ctrlD);
		await t.until(() => t!.shutdowns === 1, "shutdown on empty editor");
	});
});
