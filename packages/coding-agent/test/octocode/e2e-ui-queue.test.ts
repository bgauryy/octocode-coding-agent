import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { hang, KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** Typing while a turn streams: Enter steers, Alt+Enter queues a follow-up, Alt+Up restores the last queued message. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const ALT_ENTER = "\x1b[13;3u"; // kitty encoding
const ALT_UP = "\x1b[1;3A";
const shows = (pattern: RegExp | string) => async () => {
	const text = await t!.text();
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
};
/** The user texts a request carried, oldest first. */
const userTexts = (request: string): string[] =>
	(JSON.parse(request) as Array<{ role: string; content: Array<{ text?: string }> | string }>)
		.filter((m) => m.role === "user")
		.map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("")));

async function startBusy() {
	t = await startUi();
	const first = hang("first reply");
	t.script(first, "steer reply", "follow reply");
	await t.type("busy");
	t.press(KEY.enter);
	await t.until(() => t!.host.session.isStreaming && t!.requests.length === 1, "turn to reach the model");
	return first;
}

describe("queue while streaming", () => {
	it("shows queued messages, then delivers the steer message before the follow-up", async () => {
		const first = await startBusy();
		await t!.type("steer me");
		t!.press(KEY.enter);
		await t!.until(shows(/Next turn: steer me/), "steer in the queue list");
		await t!.type("follow me");
		t!.press(ALT_ENTER);
		await t!.until(shows(/Next turn: steer me/), "steer in the queue list");
		await t!.until(shows(/follow me/), "follow-up in the queue list");
		expect(t!.requests).toHaveLength(1);

		first.release();
		await t!.until(shows("follow reply"), "all three replies");
		await t!.until(() => !t!.host.session.isStreaming, "idle");
		expect(t!.requests).toHaveLength(3);
		expect(userTexts(t!.requests[1]).at(-1)).toBe("steer me");
		expect(userTexts(t!.requests[2]).slice(-2)).toEqual(["steer me", "follow me"]);
		expect(await t!.text()).not.toMatch(/queued/);
	});

	it("keeps a follow-up typed in the same tick as the Enter that steered", async () => {
		const first = await startBusy();
		// No awaits between keys: the follow-up arrives while the steer message is still being accepted.
		for (const ch of "steer me") t!.press(ch);
		t!.press(KEY.enter);
		for (const ch of "follow me") t!.press(ch);
		t!.press(ALT_ENTER);
		await t!.until(shows(/2 queued · 1 next turn · 1 after run/), "both messages in the queue list");
		await t!.until(shows(/Next turn: steer me/), "steer in the queue list");
		await t!.until(shows(/After run: follow me/), "follow-up in the queue list");

		first.release();
		await t!.until(shows("follow reply"), "all three replies");
		await t!.until(() => !t!.host.session.isStreaming, "idle");
		expect(t!.requests).toHaveLength(3);
		expect(userTexts(t!.requests[1]).at(-1)).toBe("steer me");
		expect(userTexts(t!.requests[2]).slice(-2)).toEqual(["steer me", "follow me"]);
	});

	it("keeps a second steer message submitted in the same tick as the first", async () => {
		await startBusy();
		for (const ch of "steer one") t!.press(ch);
		t!.press(KEY.enter);
		for (const ch of "steer two") t!.press(ch);
		t!.press(KEY.enter);
		await t!.until(shows(/2 queued · 2 next turn · 0 after run/), "both messages in the queue list");
		const listed = await t!.text();
		expect(listed).toContain("steer one");
		expect(listed).toContain("steer two");
	});

	it("Alt+Up takes the last queued message back into the editor and it is not sent", async () => {
		const first = await startBusy();
		await t!.type("steer me");
		t!.press(KEY.enter);
		await t!.until(shows(/Next turn: steer me/), "steer in the queue list");
		t!.press(ALT_UP);
		await t!.until(async () => !/Next turn: steer me/.test(await t!.text()), "queue emptied");
		expect(await t!.text()).toContain("steer me");
		first.release();
		await t!.until(() => !t!.host.session.isStreaming, "idle");
		expect(t!.requests).toHaveLength(1);
		expect(JSON.stringify(t!.host.session.messages)).not.toContain("steer me");
	});
});

/** Queues one steer and one follow-up message behind a hanging first turn and waits for both to be listed. */
async function queueTwo() {
	const first = await startBusy();
	await t!.type("steer me");
	t!.press(KEY.enter);
	await t!.until(shows(/Next turn: steer me/), "steer in the queue list");
	await t!.type("follow me");
	t!.press(ALT_ENTER);
	await t!.until(shows(/After run: follow me/), "follow-up in the queue list");
	return first;
}
const editorText = () => t!.host.editor.getText();

describe("Esc while streaming", () => {
	it("restores every queued message to the editor in order, aborts the turn and sends nothing", async () => {
		await queueTwo();
		t!.press(KEY.esc);
		await t!.until(() => editorText() === "steer me\n\nfollow me", "both messages back in the editor");
		await t!.until(() => !t!.host.session.isStreaming, "idle");
		expect(await t!.text()).not.toMatch(/queued/);
		expect(t!.requests).toHaveLength(1);
		expect(JSON.stringify(t!.host.session.messages)).not.toContain("follow me");
	});
});

describe("messages queued before a session switch", () => {
	const switched = async () => {
		await queueTwo();
		await t!.type("/new");
		t!.press(KEY.enter);
		await t!.until(shows(/Stop the running reply and start a new session/), "confirmation");
		t!.press(KEY.enter);
		await t!.until(() => !t!.host.session.isStreaming && t!.host.session.messages.length === 0, "new session");
		// Time for anything that would auto-send to do so.
		await new Promise((resolve) => setTimeout(resolve, 400));
	};

	it("stay listed in the new session with order and kind, and are not sent", async () => {
		await switched();
		const text = await t!.text();
		expect(text).toMatch(/2 queued · 1 next turn · 1 after run/);
		expect(text).toMatch(/1\. Next turn: steer me/);
		expect(text).toMatch(/2\. After run: follow me/);
		expect(t!.requests).toHaveLength(1);
		expect(t!.host.session.messages).toHaveLength(0);
	});

	it("are sent, steer first, by Enter in an empty editor", async () => {
		await switched();
		t!.press(KEY.enter);
		await t!.until(shows("follow reply"), "both replies");
		await t!.until(() => !t!.host.session.isStreaming, "idle");
		expect(t!.requests).toHaveLength(3);
		expect(userTexts(t!.requests[1])).toEqual(["steer me"]);
		expect(userTexts(t!.requests[2])).toEqual(["steer me", "follow me"]);
		expect(await t!.text()).not.toMatch(/queued/);
	});

	it("give back the last one with Alt+Up, and all of them with Esc", async () => {
		await switched();
		t!.press(ALT_UP);
		await t!.until(() => editorText() === "follow me", "last message in the editor");
		expect(await t!.text()).toMatch(/1 queued · 1 next turn/);
		t!.press(KEY.esc);
		await t!.until(() => editorText() === "steer me\n\nfollow me", "all messages in the editor");
		expect(await t!.text()).not.toMatch(/\d+ queued/);
		expect(t!.requests).toHaveLength(1);
	});

	it("are sent from the ↑ manager by editing a message and confirming", async () => {
		await switched();
		t!.press(KEY.up);
		await t!.until(shows(/\bedit\b/i), "manager open");
		t!.press(KEY.enter);
		await t!.until(shows(/Edit queued message 2/), "editor for the last message");
		t!.press(KEY.enter);
		await t!.until(() => t!.requests.length === 2, "message sent");
		expect(userTexts(t!.requests[1])).toEqual(["follow me"]);
		await t!.until(() => !t!.host.session.isStreaming, "idle");
		// The other message stays listed until the user acts on it.
		expect(t!.host.uiStore.getState().queue.compaction.map((m) => m.text)).toEqual(["steer me"]);
	});
});

describe("the queue list and long queues", () => {
	it("reorders queued messages from the ↑ manager, and the new order is the delivery order", async () => {
		const first = await startBusy();
		for (const text of ["steer one", "steer two"]) {
			await t!.type(text);
			t!.press(KEY.enter);
			await t!.until(shows(new RegExp(`Next turn: ${text}`)), `${text} listed`);
		}
		t!.press(KEY.up);
		await t!.until(shows(/\bedit\b/i), "manager open");
		t!.press("K"); // move the selected (last) message up
		await t!.until(shows(/1\. Next turn: steer two/), "reordered");
		t!.press(KEY.esc);
		first.release();
		await t!.until(() => t!.requests.length === 3 && !t!.host.session.isStreaming, "both steer turns");
		expect(userTexts(t!.requests[1]).at(-1)).toBe("steer two");
		expect(userTexts(t!.requests[2]).at(-1)).toBe("steer one");
	});

	it("deletes a queued message from the ↑ manager so it is never sent", async () => {
		const first = await queueTwo();
		t!.press(KEY.up);
		await t!.until(shows(/\bedit\b/i), "manager open");
		t!.press("d");
		await t!.until(shows(/1 queued · 1 next turn · 0 after run/), "follow-up removed");
		t!.press(KEY.esc);
		first.release();
		await t!.until(() => !t!.host.session.isStreaming && t!.requests.length === 2, "steer turn done");
		expect(JSON.stringify(t!.host.session.messages)).not.toContain("follow me");
	});

	it("counts every queued message past ten, shows the first ones and delivers them all", async () => {
		const first = await startBusy();
		const texts = Array.from({ length: 12 }, (_, i) => `note ${i + 1}`);
		t!.script(first, ...texts.map(() => "ok"));
		for (const text of texts) {
			for (const ch of text) t!.press(ch);
			t!.press(ALT_ENTER);
		}
		await t!.until(shows(/12 queued · 0 next turn · 12 after run/), "all twelve counted");
		expect(await t!.text()).toContain("1. After run: note 1");
		expect(await t!.text()).toContain("… 9 more queued");
		t!.press(KEY.esc);
		await t!.until(() => editorText().split("\n\n").length === 12, "all twelve back in the editor");
		expect(editorText().split("\n\n")).toEqual(texts);
	});
});

describe("queued messages after an aborted turn", () => {
	it("a message queued behind an aborted turn is restored by that Esc, not sent", async () => {
		await queueTwo();
		t!.press(KEY.esc);
		await t!.until(() => !t!.host.session.isStreaming, "turn aborted");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(t!.requests).toHaveLength(1);
		expect(editorText()).toBe("steer me\n\nfollow me");
	});
});

describe("messages typed during compaction", () => {
	it("are held while it runs, then sent in order with their kinds", async () => {
		t = await startUi();
		const summary = hang("SUMMARY");
		t.script("answer one", "answer two", "answer three", summary, "reply a", "reply b");
		const bulky = (label: string) => `${label} ${"lorem ipsum dolor sit amet ".repeat(1_600)}`;
		for (const [label, answer] of [
			["TURN-A", "answer one"],
			["TURN-B", "answer two"],
			["TURN-C", "answer three"],
		]) {
			t.press(`\x1b[200~${bulky(label)}\x1b[201~`);
			await t.until(shows(/\[paste #\d+ \d+ chars\]/), "the paste in the editor");
			t.press(KEY.enter);
			await t.until(shows(answer), answer);
			await t.until(() => !t!.host.session.isStreaming, "turn to finish");
		}
		await t.type("/compact");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isCompacting && t!.requests.length === 4, "compaction waiting on the summary");

		await t.type("held one");
		t.press(KEY.enter);
		await t.until(shows(/Next turn: held one/), "steer held");
		await t.type("held two");
		t.press(ALT_ENTER);
		await t.until(shows(/After run: held two/), "follow-up held");
		expect(await t.text()).toContain("waiting for compaction");
		expect(t.requests).toHaveLength(4);

		summary.release();
		await t.until(shows("reply b"), "both held messages answered");
		await t.until(() => !t!.host.session.isStreaming, "idle");
		expect(t.requests).toHaveLength(6);
		expect(userTexts(t.requests[4]).at(-1)).toBe("held one");
		expect(userTexts(t.requests[5]).slice(-2)).toEqual(["held one", "held two"]);
		expect(await t.text()).not.toMatch(/\d+ queued/);
	});
});

describe("queued messages after a failed turn", () => {
	it("are delivered after the error, and no longer listed", async () => {
		t = await startUi();
		let fail: () => void = () => {};
		const failing = () =>
			new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
				fail = () => resolve(fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }));
			});
		t.script(failing, "steer reply", "follow reply");
		await t.type("busy");
		t.press(KEY.enter);
		await t.until(() => t!.host.session.isStreaming && t!.requests.length === 1, "turn to reach the model");
		await t.type("steer me");
		t.press(KEY.enter);
		await t.until(shows(/Next turn: steer me/), "steer listed");
		fail();
		await t.until(shows("steer reply"), "the queued message answered after the failure");
		await t.until(() => !t!.host.session.isStreaming, "idle");
		expect(t.requests).toHaveLength(2);
		expect(userTexts(t.requests[1]).at(-1)).toBe("steer me");
		expect(await t.text()).not.toMatch(/\d+ queued/);
	});
});
