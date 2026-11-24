import { terminalInput, userTexts } from "./e2e-ui-flows/request.ts";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getMessageText } from "../suite/harness.ts";
import { hang, KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/**
 * The interactive session while `/compact` waits on its summary: what the user types, and what a wake-up sends, is
 * delivered once and in order whether the compaction saves, fails or is cancelled. (The saving case with the queue lists
 * is also in `e2e-ui-queue.test.ts`; the core paths are in `compaction-input-hold.test.ts`.)
 */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const ALT_ENTER = "\x1b[13;3u"; // kitty encoding
const shows = (pattern: RegExp | string) => async () => {
	const text = await t!.text();
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
};

const CHECKPOINT = "write a context checkpoint";
const isSummaryText = (text: string) =>
	text.includes(CHECKPOINT) || text.startsWith("<conversation>") || text.startsWith("# Conversation\n");
/** The requests that were ordinary turns, not summary requests. */
const turnRequests = () =>
	t!.requests.filter(
		(request) =>
			!request.includes(CHECKPOINT) && !request.includes("<conversation>") && !request.includes("# Conversation"),
	);
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

const REJECTED = "400 invalid_request_error: summarizer rejected the request";
type Ending = "success" | "fail" | "cancel";

/** Three bulky turns, then `/compact` with a summary the test controls; returns once the summary request is waiting. */
async function startCompacting(ending: Ending) {
	t = await startUi();
	const summary = hang("SUMMARY");
	// A summarizer that waits for the test, then fails. Octocode retries and falls back to the default summary, which
	// fails too, so every later summary request is refused at once while ordinary turns are answered in order.
	let fail: () => void = () => {};
	let first = true;
	let replies = 0;
	const rejected = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: REJECTED });
	const failing = (context: { messages: unknown[] }) => {
		if (!context.messages.some((message) => isSummaryText(getMessageText(message)))) {
			return Promise.resolve(fauxAssistantMessage(`reply ${"abcdef"[replies++]}`));
		}
		if (!first) return Promise.resolve(rejected());
		first = false;
		return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
			fail = () => resolve(rejected());
		});
	};
	const held = ending === "fail" ? Object.assign(failing, { release: () => fail() }) : summary;
	t.script(
		"answer one",
		"answer two",
		"answer three",
		...(ending === "fail" ? Array.from({ length: 14 }, () => failing) : [held, "reply a", "reply b", "reply c"]),
	);
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
	return held;
}

const ENDINGS: Ending[] = ["success", "fail", "cancel"];

describe("interactive input during /compact", () => {
	it.each(ENDINGS)("holds typed messages and delivers each once, in order (%s)", async (ending) => {
		const summary = await startCompacting(ending);
		await t!.type("held one");
		t!.press(KEY.enter);
		await t!.until(shows(/Next turn: held one/), "steer held");
		await t!.type("held two");
		t!.press(ALT_ENTER);
		await t!.until(shows(/After run: held two/), "follow-up held");
		expect(await t!.text()).toContain("waiting for compaction");
		expect(t!.requests).toHaveLength(4);

		if (ending !== "cancel") summary.release();
		else t!.host.session.abortCompaction();
		await t!.until(shows("reply b"), "both held messages answered");
		await t!.until(() => !t!.host.session.isStreaming && !t!.host.session.isCompacting, "idle");

		const sent = turnRequests().slice(3);
		expect(sent).toHaveLength(2);
		expect(userTexts(sent[0]).at(-1)).toBe(terminalInput("held one"));
		expect(userTexts(sent[1]).slice(-2)).toEqual(["held one", "held two"].map(terminalInput));
		const transcript = JSON.stringify(t!.host.session.messages);
		expect(occurrences(transcript, "held one")).toBe(1);
		expect(occurrences(transcript, "held two")).toBe(1);
		expect(t!.host.session.getQueuedInputs()).toEqual([]);
		expect(await t!.text()).not.toMatch(/\d+ queued|waiting for compaction/);
		const compacted = t!.host.sessionManager.getEntries().some((entry) => entry.type === "compaction");
		expect(compacted).toBe(ending === "success");
	});

	it.each(ENDINGS)("holds a wake-up message until the compaction ends, then answers it once (%s)", async (ending) => {
		const summary = await startCompacting(ending);
		await t!.host.session.sendCustomMessage(
			{ customType: "wake", content: "WAKE-UP-CALL", display: true },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		// Nothing runs beside the summary request.
		expect(t!.host.session.isStreaming).toBe(false);
		expect(t!.requests).toHaveLength(4);
		expect(JSON.stringify(t!.host.session.messages)).not.toContain("WAKE-UP-CALL");

		if (ending !== "cancel") summary.release();
		else t!.host.session.abortCompaction();
		await t!.until(shows("reply a"), "the wake-up answered after the compaction");
		await t!.until(() => !t!.host.session.isStreaming && !t!.host.session.isCompacting, "idle");
		expect(userTexts(turnRequests()[3]).at(-1)).toBe("WAKE-UP-CALL");
		const transcript = JSON.stringify(t!.host.session.messages);
		expect(occurrences(transcript, "WAKE-UP-CALL")).toBe(1);
		expect(turnRequests()).toHaveLength(4);
		expect(t!.host.session.getQueuedInputs()).toEqual([]);
	});

	it.each(ENDINGS)(
		"holds a prompt sent straight to the session and answers it once afterwards (%s)",
		async (ending) => {
			const summary = await startCompacting(ending);
			await t!.host.session.prompt("direct prompt");
			expect(t!.requests).toHaveLength(4);
			expect(JSON.stringify(t!.host.session.messages)).not.toContain("direct prompt");
			if (ending !== "cancel") summary.release();
			else t!.host.session.abortCompaction();
			await t!.until(shows("reply a"), "the prompt answered after the compaction");
			await t!.until(() => !t!.host.session.isStreaming && !t!.host.session.isCompacting, "idle");
			expect(userTexts(turnRequests()[3]).at(-1)).toBe(terminalInput("direct prompt"));
			expect(occurrences(JSON.stringify(t!.host.session.messages), "direct prompt")).toBe(1);
			expect(turnRequests()).toHaveLength(4);
			expect(t!.host.session.getQueuedInputs()).toEqual([]);
		},
	);
});
