import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/** `/export` to JSONL and HTML, then `/import` back, through the editor on an xterm grid. */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const shows = (pattern: RegExp | string) => async () => {
	const text = await t!.text();
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
};
const gone = (text: string) => async () => !(await t!.text()).includes(text);
const command = async (line: string) => {
	await t!.type(line);
	t!.press(KEY.enter);
};
const ask = async (text: string, answer: string) => {
	await command(text);
	await t!.until(shows(answer), `answer "${answer}"`);
	await t!.until(() => !t!.host.session.isStreaming, "turn to finish");
};
/** The roles of the user's turns and the model's replies (system notes aside). */
const conversation = () => t!.host.session.messages.map((m) => m.role).filter((role) => role !== "system");
/** A fresh directory outside the project for exported files. */
const exportDir = () => fs.mkdtempSync(path.join(t!.root, "export-"));

describe("/export", () => {
	it("writes the session as JSONL with its messages and reports the path", async () => {
		t = await startUi();
		t.script("the answer is cobalt");
		await ask("what colour is the vault", "the answer is cobalt");
		const file = path.join(exportDir(), "session copy.jsonl");
		await command(`/export "${file}"`);
		await t.until(shows("Session exported to:"), "export status");
		const lines = fs
			.readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		const raw = JSON.stringify(lines);
		expect(lines[0].type).toBe("session");
		expect(raw).toContain("what colour is the vault");
		expect(raw).toContain("the answer is cobalt");
	});

	it("writes the session as a self-contained HTML page when the path is not .jsonl", async () => {
		t = await startUi();
		t.script("html answer: teal");
		await ask("pick a colour for the page", "html answer: teal");
		const file = path.join(exportDir(), "transcript.html");
		await command(`/export ${file}`);
		await t.until(shows("Session exported to:"), "export status");
		const html = fs.readFileSync(file, "utf8");
		expect(html.startsWith("<!DOCTYPE html>") || html.startsWith("<!doctype html>")).toBe(true);
		// The session is embedded as data in the page, not fetched from anywhere.
		expect(html.length).toBeGreaterThan(5_000);
	});

	it("reports a failure when the target cannot be written (a path under a regular file)", async () => {
		t = await startUi();
		t.script("fine");
		await ask("hello", "fine");
		await command(`/export ${path.join(t.cwd, "app.ts", "x.jsonl")}`);
		await t.until(shows(/Failed to export session/), "error shown");
		expect(await t.text()).toMatch(/Failed to export session/);
		expect(await t.text()).not.toContain("Session exported to:");
	});
});

describe("/export then /import", () => {
	it("round-trips: a new session is empty, importing the JSONL restores the transcript and the model context", async () => {
		t = await startUi();
		t.script("reply about kumquats", "reply after import");
		await ask("tell me about KUMQUAT-QUESTION", "reply about kumquats");
		const file = path.join(exportDir(), "round.jsonl");
		await command(`/export ${file}`);
		await t.until(shows("Session exported to:"), "export status");

		await command("/new");
		await t.until(gone("reply about kumquats"), "transcript cleared by /new");
		expect(conversation()).toEqual([]);

		await command(`/import ${file}`);
		await t.until(shows("Replace current session"), "import confirmation");
		// No is preselected: accepting takes a deliberate move to Yes.
		t.press(KEY.down);
		t.press(KEY.enter);
		await t.until(shows("Session imported from:"), "import status");
		await t.until(shows("reply about kumquats"), "transcript restored");
		expect(await t.text()).toContain("KUMQUAT-QUESTION");
		expect(conversation()).toEqual(["user", "assistant"]);

		// The model sees the imported history with the next prompt.
		await ask("and then?", "reply after import");
		expect(t.requests).toHaveLength(2);
		expect(t.requests[1]).toContain("KUMQUAT-QUESTION");
		expect(t.requests[1]).toContain("reply about kumquats");
	});

	it("declining the confirmation keeps the current session", async () => {
		t = await startUi();
		t.script("first session reply", "x");
		await ask("ORIGINAL-QUESTION", "first session reply");
		const file = path.join(exportDir(), "keep.jsonl");
		await command(`/export ${file}`);
		await t.until(shows("Session exported to:"), "export status");
		await command(`/import ${file}`);
		await t.until(shows("Replace current session"), "import confirmation");
		t.press(KEY.esc);
		await t.until(shows("Import cancelled"), "cancel status");
		expect(conversation()).toEqual(["user", "assistant"]);
		expect(await t.text()).toContain("ORIGINAL-QUESTION");
	});

	it("importing a file that does not exist reports an error", async () => {
		t = await startUi();
		await command(`/import ${path.join(t.root, "missing.jsonl")}`);
		await t.until(shows("Replace current session"), "import confirmation");
		t.press(KEY.down);
		t.press(KEY.enter);
		await t.until(shows(/Failed to import session/), "error shown");
		expect(await t.text()).toMatch(/Failed to import session/);
		expect(await t.text()).not.toContain("Session imported from:");
		expect(conversation()).toEqual([]);
	});
});
