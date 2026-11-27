import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { recordUntrackedRenders } from "@octocodeai/octocode-tui";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/**
 * Every part of a settled transcript row must be render-tracked: an untracked one makes its row render again on every
 * frame, off screen too, so frame cost grows with the transcript. Real tool rows and an answer are drawn through the
 * interactive host, then one quiet frame of the transcript is recorded.
 */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const ANSWER = [
	"Done. **Summary**:",
	"",
	"| file | lines |",
	"| --- | ---: |",
	"| notes | 2 |",
	"",
	"```ts",
	"const x = 1;",
	"```",
];
const WIDTH = 118;

describe("transcript render tracking", () => {
	it("a quiet frame of finished tool rows and an answer renders no untracked component", async () => {
		t = await startUi();
		const file = join(t.cwd, "notes.txt");
		t.script(
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "seq 1 40", reason: "long output" }),
					fauxToolCall("bash", { command: "echo oops; exit 3", reason: "a failing command" }),
					fauxToolCall("file", {
						reason: "Write the notes",
						queries: [{ type: "write", path: file, content: "alpha\nbeta\n" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			ANSWER.join("\n"),
		);
		await t.type("work");
		t.press(KEY.enter);
		await t.until(async () => (await t!.text()).includes("Summary"), "the answer on screen");
		await t.until(() => !t!.host.session.isStreaming, "idle");
		const screen = await t.text();
		// The finished command closes to its summary line; the failed one keeps its output in view.
		expect(screen).toContain("exit 0 · 40 lines (ctrl+o");
		expect(screen).not.toContain("earlier lines");
		expect(screen).toContain("oops");

		const chat = t.host.chatContainer;
		chat.render(WIDTH);
		let stop = recordUntrackedRenders();
		chat.render(WIDTH);
		expect(Object.fromEntries(stop())).toEqual({});

		// The check sees a part that is not tracked.
		class Untracked {
			render = () => ["x"];
			invalidate() {}
		}
		chat.addChild(new Untracked());
		chat.render(WIDTH);
		stop = recordUntrackedRenders();
		chat.render(WIDTH);
		expect(Object.fromEntries(stop())).toEqual({ Untracked: 1 });
	});
});
