import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { nativeCall } from "./e2e-calls.ts";
import { KEY, startUi, type UiHarness } from "./e2e-ui-flows/ui.ts";

/**
 * Terminal permission prompts for an ordinary `file` edit, and plan approval, in real interactive sessions with a scripted
 * model. `manual` is the mode where a repository file change asks (`permission/mode.ts`, `file.workspace`); the dialog is
 * answered with keys through the terminal, as a user would.
 */
let t: UiHarness | undefined;
afterEach(async () => {
	await t?.stop();
	t = undefined;
});

const ONCE = "Apply all";
const SESSION = "Allow all file changes in the repository for this session";
const DENY = "Reject all";

const write = (file: string, content = "hello\n") =>
	fauxAssistantMessage(
		[
			nativeCall("file", {
				queries: [{ reason: "add", type: "write", path: file, content }],
			}),
		],
		{ stopReason: "toolUse" },
	);

const screen = () => t!.text();
const shows = (pattern: RegExp | string) => async () => {
	const text = await screen();
	return typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);
};
const idle = () => t!.until(() => !t!.host.session.isStreaming, "the turn to end", 30_000);
const exists = (file: string) => fs.existsSync(path.join(t!.cwd, file));

/** The dialog's rows, to move the cursor to the one whose label is `label`. */
async function choose(label: string): Promise<void> {
	const rows = (await t!.grid()).map((row) => row.replace(/^[\s│>›❯→▸*]+/, "").trim());
	const first = rows.findIndex((row) => row === ONCE || row.startsWith(ONCE));
	const target = rows.findIndex((row, index) => index >= first && row.startsWith(label));
	expect(first, `the dialog lists ${ONCE}`).toBeGreaterThanOrEqual(0);
	expect(target, `the dialog lists ${label}\n${rows.join("\n")}`).toBeGreaterThanOrEqual(0);
	for (let step = first; step < target; step++) t!.press(KEY.down);
	await new Promise((resolve) => setTimeout(resolve, 100));
	t!.press(KEY.enter);
}

/** The tool results the model was sent in its latest request. */
function lastToolResults(): string {
	const messages = JSON.parse(t!.requests.at(-1)!) as Array<{ role: string; content?: unknown }>;
	return messages
		.filter((message) => message.role === "toolResult")
		.map((message) => JSON.stringify(message.content))
		.join("\n");
}

async function manualSession() {
	t = await startUi();
	const switched = await t.submit("/permissions manual");
	expect(switched.settled).toBe(true);
	await t.until(shows(/manual/), "the mode change");
	return t;
}

async function ask(prompt: string, file: string) {
	t!.script(write(file), `done ${file}`);
	await t!.type(prompt);
	t!.press(KEY.enter);
	await t!.until(shows(ONCE), `the permission dialog for ${file}`, 30_000);
}

describe("a file edit in a mode where file writes ask", () => {
	it("Allow once creates the file, and the next edit asks again", async () => {
		await manualSession();
		await ask("make one", "one.txt");
		expect(exists("one.txt")).toBe(false);
		await choose(ONCE);
		await t!.until(shows("done one.txt"), "the reply after the edit", 30_000);
		await idle();
		expect(fs.readFileSync(path.join(t!.cwd, "one.txt"), "utf8")).toBe("hello\n");

		await ask("make two", "two.txt");
		expect(exists("two.txt")).toBe(false);
		await choose(DENY);
		await idle();
	});

	it("Deny leaves the file absent and the model receives a refusal", async () => {
		await manualSession();
		await ask("make one", "denied.txt");
		await choose(DENY);
		await t!.until(shows("done denied.txt"), "the reply after the refusal", 30_000);
		await idle();
		expect(exists("denied.txt")).toBe(false);
		const results = lastToolResults();
		expect(results).toMatch(/The user denied .*Do not retry it/);
		expect(results).not.toMatch(/Wrote|Created/i);
	});

	it("the session-wide choice skips the second ask for the same kind of edit", async () => {
		await manualSession();
		await ask("make one", "a.txt");
		await choose(SESSION);
		await t!.until(shows("done a.txt"), "the first reply", 30_000);
		await idle();
		expect(exists("a.txt")).toBe(true);

		t!.script(write("b.txt"), "done b.txt");
		await t!.type("make another");
		t!.press(KEY.enter);
		await t!.until(shows("done b.txt"), "the second reply with no dialog", 30_000);
		await idle();
		expect(exists("b.txt")).toBe(true);
		expect(await screen()).not.toContain(ONCE);
	});
});

describe("plan mode", () => {
	it("blocks a write, and the same write succeeds after the user approves the plan", async () => {
		t = await startUi();
		t.script(write("planned.txt"), "Plan: create planned.txt with a greeting.");
		const entered = await t.submit("/plan add a greeting file");
		expect(entered.error).toBeUndefined();
		await t.until(shows("Plan: create planned.txt"), "the plan text", 30_000);
		await idle();
		expect(exists("planned.txt")).toBe(false);
		expect(lastToolResults()).toMatch(/Plan mode blocks file/);
		await t.until(
			() =>
				t!.host.sessionManager
					.getBranch()
					.some(
						(e) =>
							e.type === "custom" &&
							e.customType === "octocode-plan" &&
							(e.data as { revision?: number }).revision === 1,
					),
			"the plan saved as revision 1",
			30_000,
		);

		t.script(write("planned.txt"), "implemented");
		const approved = await t.submit("/plan --approve 1");
		expect(approved.error).toBeUndefined();
		await t.until(shows("implemented"), "the implementation reply", 30_000);
		await idle();
		expect(fs.readFileSync(path.join(t.cwd, "planned.txt"), "utf8")).toBe("hello\n");
	});
});
