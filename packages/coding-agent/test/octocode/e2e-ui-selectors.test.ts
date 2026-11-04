import { afterEach, describe, expect, it } from "vitest";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** Selector flows (/model, /resume, /tree) driven by keys on an xterm grid; assertions read rows and persisted state. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const shows = (pattern: RegExp | string) => async () => {
	const text = await t!.text();
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
};
const ask = async (text: string, answer: string) => {
	await t!.type(text);
	t!.press(KEY.enter);
	await t!.until(shows(answer), `answer "${answer}"`);
	await t!.until(() => !t!.host.session.isStreaming, "turn to finish");
};

describe("/model", () => {
	it("selecting another model switches the session, the footer, the persisted log and the next request", async () => {
		t = await startUi({ models: ["faux-1", "faux-2"] });
		await t.type("/model");
		t.press(KEY.enter);
		await t.until(shows("Choose a model for this chat"), "model selector");
		await t.until(shows(/✓ faux-1/), "current model marked");
		await t.until(shows("Model catalogs refreshed"), "catalog refresh finished");
		t.press(KEY.down);
		await t.until(shows(/›\s+faux-2/), "cursor on faux-2");
		t.press(KEY.enter);
		await t.until(shows(/faux\/faux-2 · permission/), "footer shows faux-2");
		expect(t.host.session.model?.id).toBe("faux-2");
		expect(await t.text()).toMatch(/faux\/faux-2 · permission/);
		expect(t.host.sessionManager.getEntries().some((e) => e.type === "model_change" && e.modelId === "faux-2")).toBe(
			true,
		);
		t.script("from two");
		await ask("hi", "from two");
		expect(t.host.session.messages.filter((m) => m.role === "assistant").at(-1)).toMatchObject({ model: "faux-2" });
	});

	it("Escape closes the selector and keeps the model", async () => {
		t = await startUi({ models: ["faux-1", "faux-2"] });
		await t.type("/model");
		t.press(KEY.enter);
		await t.until(shows("Choose a model for this chat"), "model selector");
		t.press(KEY.down);
		t.press(KEY.esc);
		await t.until(async () => !(await t!.text()).includes("Choose a model for this chat"), "selector closed");
		expect(t.host.session.model?.id).toBe("faux-1");
	});
});

describe("/resume", () => {
	it("picking another session switches to it and replays its transcript", async () => {
		t = await startUi();
		t.script("alpha answer", "beta answer");
		await ask("alpha question", "alpha answer");
		const alphaId = t.host.sessionManager.getSessionId();
		await t.type("/new");
		t.press(KEY.enter);
		await t.until(() => t!.host.sessionManager.getSessionId() !== alphaId, "new session");
		await ask("beta question", "beta answer");
		const betaId = t.host.sessionManager.getSessionId();
		expect(await t.text()).not.toContain("alpha answer");

		await t.type("/resume");
		t.press(KEY.enter);
		await t.until(shows("Resume session"), "session picker");
		await t.until(shows("alpha question"), "alpha listed");
		// The list is most-recent first; move to the alpha row.
		for (let i = 0; i < 3 && !/›\s+(◆ )?alpha question/.test(await t.text()); i++) {
			t.press(KEY.down);
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
		t.press(KEY.enter);
		await t.until(() => t!.host.sessionManager.getSessionId() === alphaId, "session switched");
		await t.until(shows("alpha answer"), "alpha transcript replayed");
		const text = await t.text();
		expect(text).toContain("alpha question");
		expect(text).not.toContain("beta answer");
		expect(t.host.sessionManager.getSessionId()).not.toBe(betaId);
	});
});

describe("/tree", () => {
	const openTree = async () => {
		await t!.type("/tree");
		t!.press(KEY.enter);
		await t!.until(shows("Session Tree"), "tree selector");
	};

	it("navigating to an earlier turn without a summary moves the leaf and rewinds the transcript", async () => {
		t = await startUi();
		t.script("first answer", "second answer");
		await ask("hello one", "first answer");
		await ask("hello two", "second answer");
		const target = t.host.sessionManager
			.getEntries()
			.find((e) => e.type === "message" && e.message.role === "assistant")!;
		await openTree();
		t.press(KEY.up);
		t.press(KEY.up);
		await t.until(shows(/›\s+•\s+assistant: first answer/), "cursor on first answer");
		t.press(KEY.enter);
		await t.until(shows("Summarize branch?"), "summary prompt");
		t.press(KEY.enter); // "No summary"
		await t.until(shows("Navigated to selected point"), "navigation confirmation");
		expect(t.host.sessionManager.getLeafId()).toBe(target.id);
		const text = await t.text();
		expect(text).toContain("first answer");
		expect(text).not.toContain("second answer");
		// The next prompt branches from there: the model no longer sees the abandoned turn.
		t.script("branch answer");
		await ask("hello three", "branch answer");
		expect(t.requests.at(-1)).not.toContain("hello two");
	});

	it("navigating with a summary persists a branch summary entry", async () => {
		t = await startUi();
		t.script("first answer", "second answer", "the branch summary");
		await ask("hello one", "first answer");
		await ask("hello two", "second answer");
		await openTree();
		t.press(KEY.up);
		t.press(KEY.up);
		await t.until(shows(/›\s+•\s+assistant: first answer/), "cursor on first answer");
		t.press(KEY.enter);
		await t.until(shows("Summarize branch?"), "summary prompt");
		t.press(KEY.down);
		t.press(KEY.enter); // "Summarize"
		await t.until(
			() => t!.host.sessionManager.getEntries().some((e) => e.type === "branch_summary"),
			"branch summary entry",
		);
		const entry = t.host.sessionManager.getEntries().find((e) => e.type === "branch_summary");
		expect(JSON.stringify(entry)).toContain("the branch summary");
		expect(t.requests.at(-1)).toContain("hello two");
	});
});
