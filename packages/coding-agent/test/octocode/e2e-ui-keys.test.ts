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
		const reply = hang();
		t.script(reply);
		await t.type("work");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming, "turn to start");
		// Abort the stream itself: the run spends a moment preparing before it calls the model.
		await t.until(() => reply.started(), "the model call");
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

describe("Esc before the run reaches the model", () => {
	it("puts the prompt back in the editor and says it was not sent", async () => {
		t = await startUi();
		const reply = hang();
		t.script(reply);
		// A slow before_agent_start handler: the run is still preparing when Esc arrives.
		const runner = t.host.session.featureHost;
		const emit = runner.emitBeforeAgentStart.bind(runner);
		let entered = false;
		runner.emitBeforeAgentStart = async (...args) => {
			entered = true;
			await sleep(600);
			return emit(...args);
		};
		await t.type("keep me");
		t.press(KEY.enter);
		await t.until(() => entered, "before_agent_start to begin");
		t.press(KEY.esc);
		await t.until(() => !t!.host.session.isStreaming, "turn to stop");
		await t.until(async () => /back in the editor/.test(await t!.text()), "cancelled notice");
		expect(t.host.editor.getText()).toBe("keep me");
		const messages = t.host.session.messages as Array<{ role: string }>;
		expect(messages.some((m) => m.role === "user")).toBe(false);
		expect(reply.started()).toBe(false);
	});
});

describe("Ctrl+C and Ctrl+D", () => {
	it("a single Ctrl+C clears the draft, says a second one exits, and does not exit", async () => {
		t = await startUi();
		await t.type("draft text");
		expect(await t.text()).toContain("draft text");
		t.press(KEY.ctrlC);
		await sleep(150);
		const screen = await t.text();
		expect(screen).not.toContain("draft text");
		expect(screen).toContain("ctrl+c again to exit");
		expect(t.shutdowns).toBe(0);
		// The note goes with the window.
		await t.until(async () => !(await t!.text()).includes("again to exit"), "the exit note to go");
	});

	it("a single Ctrl+C on an empty editor says a second one exits, and does not exit", async () => {
		t = await startUi();
		t.press(KEY.ctrlC);
		await t.until(async () => (await t!.text()).includes("ctrl+c again to exit"), "the exit note");
		expect(t.shutdowns).toBe(0);
	});

	it("Ctrl+C during a run interrupts it as Esc does, keeps the draft and says a second one exits", async () => {
		t = await startUi();
		const reply = hang();
		t.script(reply);
		await t.type("work");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming, "turn to start");
		await t.until(() => reply.started(), "the model call");
		await t.type("next idea");
		t.press(KEY.ctrlC);
		await t.until(() => !t!.host.session.isStreaming, "turn to stop");
		const messages = t.host.session.messages as Array<{ role: string; stopReason?: string }>;
		expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(t.host.editor.getText()).toBe("next idea");
		expect(await t.text()).toContain("ctrl+c again to exit");
		expect(t.shutdowns).toBe(0);
	});

	it("two Ctrl+C within the window exit", async () => {
		t = await startUi();
		t.press(KEY.ctrlC);
		t.press(KEY.ctrlC);
		await t.until(() => t!.shutdowns === 1, "shutdown");
		expect(t.shutdowns).toBe(1);
	});

	it("two slow Ctrl+C presses do not exit", async () => {
		t = await startUi();
		t.press(KEY.ctrlC);
		// The window is 1 s (it was 500 ms): long enough to read the note the first press shows and act on it.
		await sleep(1150);
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
