import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { hang, KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** Input and flow edge cases of the interactive host: dialogs while a turn runs, commands during a turn, Esc handling. */
let t: UiHarness | undefined;
const scratch: string[] = [];
afterEach(async () => {
	await t?.stop();
	t = undefined;
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const shows = (pattern: RegExp | string) => async () => {
	const text = await t!.text();
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
};
const idle = () => t!.until(() => !t!.host.session.isStreaming, "idle");
const userTexts = (request: string): string[] =>
	(JSON.parse(request) as Array<{ role: string; content: Array<{ text?: string }> | string }>)
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("")));

describe("approval dialog while the user types", () => {
	async function openApproval() {
		// A path outside the workspace, so the `workspace` permission mode asks.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b46-approval-"));
		scratch.push(dir);
		const marker = path.join(dir, "ran");
		t = await startUi();
		t.script(
			fauxAssistantMessage([fauxToolCall("bash", { command: `touch ${marker}`, reason: "make a marker" })], {
				stopReason: "toolUse",
			}),
			"all done",
		);
		await t.type("run it");
		t.press(KEY.enter);
		await t.until(shows("Run this command?"), "the approval dialog");
		return marker;
	}

	it("queues text typed at the dialog as a steer message and does not approve on its Enter", async () => {
		const marker = await openApproval();
		await t!.type("steer me now");
		t!.press(KEY.enter);
		await t!.until(shows(/Next turn: steer me now/), "the steer message in the queue list");
		expect(await t!.text()).toContain("Run this command?");
		expect(fs.existsSync(marker)).toBe(false);
		expect(t!.requests).toHaveLength(1);

		// The dialog's own Enter (Allow once) approves; the steer message goes with the next request.
		t!.press(KEY.enter);
		await t!.until(shows("all done"), "the reply after approval");
		await idle();
		expect(fs.existsSync(marker)).toBe(true);
		expect(userTexts(t!.requests.at(-1)!).at(-1)).toBe("steer me now");
	});

	it("shows the text being typed and lets Backspace edit it", async () => {
		await openApproval();
		await t!.type("abcd");
		t!.press("\x7f");
		await t!.type("x");
		await t!.until(shows("abcx"), "the draft line");
		expect(await t!.text()).not.toContain("abcdx");
	});

	it("Esc clears typed text first and denies only when there is none", async () => {
		const marker = await openApproval();
		await t!.type("oops");
		t!.press(KEY.esc);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(await t!.text()).toContain("Run this command?");
		expect(await t!.text()).not.toContain("oops");
		t!.press(KEY.esc);
		await t!.until(async () => !(await t!.text()).includes("Run this command?"), "the dialog to close");
		expect(fs.existsSync(marker)).toBe(false);
	});
});

describe("/compact while a reply streams", () => {
	it("waits for the turn to finish, then compacts; the reply is never aborted", async () => {
		t = await startUi();
		const first = hang("the whole reply");
		t.script(first, "the summary");
		await t.type("busy");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming && t!.requests.length === 1, "turn to reach the model");
		await t.type("/compact");
		t.press(KEY.enter);
		await t.until(shows(/after this turn/i), "the notice that compaction waits");
		expect(await t.text()).not.toContain("Interrupted");
		expect(t.host.session.isStreaming).toBe(true);

		first.release();
		await t.until(shows("the whole reply"), "the full reply");
		// The scripted session is too small to summarise: the command ran, after the reply, and answered so.
		await t.until(
			async () => (await t!.text()).split("the whole reply")[1]?.includes("Nothing to compact yet") ?? false,
			"the compaction to run after the reply",
		);
		expect(await t.text()).not.toContain("Interrupted");
		expect(t.requests).toHaveLength(1);
	});
});

describe("Esc handling", () => {
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	async function startRun() {
		t = await startUi();
		t.script(hang());
		await t.type("work");
		t.press(KEY.enter);
		// The model step must be waiting before Esc: an abort that lands earlier leaves no assistant message to check.
		await t.until(() => t!.host.session.isStreaming && t!.requests.length === 1, "turn to reach the model");
	}

	it("aborts a run when two Esc bytes arrive in one read", async () => {
		await startRun();
		t!.press(KEY.esc + KEY.esc);
		await t!.until(() => !t!.host.session.isStreaming, "turn to stop");
		await t!.until(
			() => (t!.host.session.messages as Array<{ stopReason?: string }>).at(-1)?.stopReason === "aborted",
			"the aborted reply",
		);
		expect(t!.host.session.isStreaming).toBe(false);
		expect((t!.host.session.messages as Array<{ stopReason?: string }>).at(-1)?.stopReason).toBe("aborted");
		expect(t!.requests).toHaveLength(1);
	});

	it("does not open the Session Tree while Esc is mashed after an abort, and typed text stays in the editor", async () => {
		await startRun();
		t!.press(KEY.esc);
		for (let i = 0; i < 12; i++) {
			await sleep(100); // 1.2 s of mashing, well past one 500 ms window
			t!.press(KEY.esc);
		}
		await t!.until(() => !t!.host.session.isStreaming, "turn to stop");
		await t!.type("hello");
		expect(await t!.text()).not.toContain("Session Tree");
		expect(t!.host.editor.getText()).toBe("hello");
	});

	it("still opens the tree for a deliberate double Esc after a pause", async () => {
		await startRun();
		t!.press(KEY.esc);
		await t!.until(() => !t!.host.session.isStreaming, "turn to stop");
		await sleep(700);
		t!.press(KEY.esc);
		await sleep(100);
		t!.press(KEY.esc);
		await t!.until(shows("Session Tree"), "the tree selector");
		expect(await t!.text()).toContain("Session Tree");
	});
});

describe("working indicator", () => {
	it("stays on across an agent_end inside a run (retry, continue) and clears at settle", async () => {
		t = await startUi();
		const reply = hang("done");
		t.script(reply);
		await t.type("work");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming, "turn to start");
		await t.until(() => t!.host.activeStatusIndicator?.kind === "working", "the working indicator");

		// A retry or continue ends one agent segment and starts the next while the run is still going.
		await t.host.handleEvent({ type: "agent_end", messages: [] } as never);
		expect(t.host.activeStatusIndicator?.kind).toBe("working");

		reply.release();
		await t.until(() => !t!.host.session.isStreaming, "idle");
		await t.until(
			() => t!.host.activeStatusIndicator?.kind !== "working",
			"the indicator to clear when the run settles",
		);
	});
});

describe("a background job result while a reply streams", () => {
	it("is drawn above the streaming message, which stays whole", async () => {
		t = await startUi();
		const reply = hang("the reply");
		t.script(reply);
		await t.type("work");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming, "turn to start");

		// Mid-message: the application layer has an assistant message component open (host.streamingComponent).
		const streaming = new AssistantMessageComponent(undefined, false, t.host.getMarkdownThemeWithSettings());
		streaming.updateMessage(
			{ role: "assistant", content: [{ type: "text", text: "first half of the message" }] } as never,
			true,
		);
		t.host.chatContainer.addChild(streaming);
		t.host.streamingComponent = streaming;
		t.host.addMessageToChat({
			role: "custom",
			customType: "job-result",
			content: "Background bash bash-1 finished after 1s: sleep 1",
			display: true,
			timestamp: Date.now(),
		} as never);

		const children = t.host.chatContainer.children;
		const row = children.findIndex((child) => child.constructor.name === "CustomMessageComponent");
		expect(row).toBeGreaterThanOrEqual(0);
		expect(row).toBeLessThan(children.indexOf(streaming));
		expect(children.at(-1)).toBe(streaming);
		t.host.streamingComponent = undefined;
		reply.release();
	});
});
