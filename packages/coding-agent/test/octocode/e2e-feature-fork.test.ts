import { afterAll, beforeAll, expect, it } from "vitest";
import { type InteractiveHarness, startInteractive } from "./e2e-commands-harness.ts";

/**
 * `/fork` through the terminal editor, on a session whose commands the feature host registered: with nothing to fork
 * from it says so, and after a prompt it opens the message selector and confirms the fork it makes.
 */
let t: InteractiveHarness;

beforeAll(async () => {
	t = await startInteractive();
}, 120_000);
afterAll(async () => t?.stop());

const screen = (host: InteractiveHarness["host"]) =>
	[host.chatContainer, host.statusContainer, host.editorContainer]
		.flatMap((container) => container.render(120))
		.join("\n")
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

it("says there is nothing to fork from before the first prompt", async () => {
	const run = await t.submit("/fork");
	expect(run.error).toBeUndefined();
	expect(run.text).toMatch(/No messages to fork from/);
	expect(run.dialogs).toEqual([]);
});

it("offers the sent prompt in the selector and confirms the fork when it is chosen", async () => {
	t.reply("scripted reply");
	const prompt = "fork me from this prompt";
	const sent = await t.submit(prompt);
	expect(sent.settled).toBe(true);
	const original = t.host.sessionManager.getSessionId();

	// Not `submit`: it dismisses a selector with Escape, and this one is answered with Enter.
	const opened = Promise.resolve(t.host.defaultEditor.onSubmit?.("/fork"));
	await expect.poll(() => screen(t.host), { timeout: 10_000 }).toContain("\n Fork from a message");
	expect(screen(t.host)).toMatch(new RegExp(`\\n› ${prompt}\\s*\\n  Message 1 of 1`));
	t.host.renderer.getFocusedComponent()?.handleInput?.("\r");
	await opened;

	await expect.poll(() => screen(t.host), { timeout: 15_000 }).toContain("Forked to new session");
	expect(t.host.sessionManager.getSessionId()).not.toBe(original);
	expect(t.host.editor.getText()).toBe(prompt);
});
