import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	answer,
	close,
	dialogs,
	message,
	octocodeApi,
	prompt,
	reachedStep,
	requestsOf,
	resultsOf,
	script,
	session,
	type Session,
	settledRuns,
} from "./e2e-a2a-helpers.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	type Sandbox,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";

/** Receiving an external message is one permission class: real processes, real dialogs answered as a terminal would. */
let endpoint: Endpoint;
vi.setConfig({ testTimeout: 240_000 });

beforeAll(async () => {
	endpoint = await startEndpoint();
});
afterAll(async () => {
	await endpoint?.close();
});
afterEach(async (context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	await killEverything();
	endpoint.requests.length = 0;
});

const ONCE = "Allow once";
const ALL = "Allow all external messages for this session";
const fromProcess = (name: string) => `Allow messages from ${name} for this session`;
// Contract change (user decision 3): a confirmed process can also be denied for the session.
const denyProcess = (name: string) => `Deny messages from ${name} for this session`;

/** A session in `manual`, while the senders below stay in the default `full`. */
async function manualSession(box: Sandbox): Promise<Session> {
	box.env.OCTOCODE_PERMISSION = "manual";
	const started = await session(box);
	delete box.env.OCTOCODE_PERMISSION;
	return started;
}

/** `from` sends `to` a message through `agent` `message`; the script says what `to`'s model does with it. */
async function send(from: Session, to: Session, steps: string, text = "Please look.") {
	const sending = script([message(to.name, `${text} ${steps}`), { text: "sent" }]);
	prompt(from.run, `send-${Math.random()}`, sending);
	await reachedStep(endpoint, sending, 1, "the sender's receipt");
	return resultsOf(endpoint, sending);
}

const reached = (steps: string) => requestsOf(endpoint, steps).length > 0;

describe("in manual mode", () => {
	it("the dialog names the process, its request and that it is external; once holds for one message; tools still ask", async () => {
		const box = sandbox(endpoint);
		const receiver = await manualSession(box);
		const sender = await session(box);
		const marker = path.join(box.root, "ran");
		const first = script([
			{ tool: "bash", args: { command: `echo ran > ${JSON.stringify(marker)}` } },
			{ text: "done" },
		]);
		const receipt = await send(sender, receiver, first, "Run the suite.");
		// The sender hears at once, and is not blocked.
		expect(receipt).toContain(`Waiting for ${receiver.name}'s user`);
		await until(() => dialogs(receiver.run).length === 1, "the dialog");
		const [dialog] = dialogs(receiver.run);
		expect(dialog.title).toContain("Let this external message reach the agent?");
		expect(dialog.title).toContain(`from ${sender.name} (external, not you)`);
		expect(dialog.title).toContain("Run the suite.");
		expect(dialog.options).toEqual([
			ONCE,
			fromProcess(sender.name),
			ALL,
			"Deny",
			denyProcess(sender.name),
			expect.any(String),
		]);
		expect(reached(first)).toBe(false);
		answer(receiver.run, dialog.id, ONCE);

		// Accepted, and its tool asks like any other in manual: accepting widens nothing.
		await until(() => dialogs(receiver.run).length === 2, "the tool's own dialog");
		const tool = dialogs(receiver.run)[1];
		expect(tool.title).toContain("echo ran");
		expect(fs.existsSync(marker)).toBe(false);
		answer(receiver.run, tool.id, "Deny");
		await until(() => requestsOf(endpoint, first).some((request) => request.step >= 1), "the rest of the turn");
		expect(fs.existsSync(marker)).toBe(false);
		// A send still being prepared when a run settles is refused (nothing sent): send the next one after this run.
		await until(() => settledRuns(receiver.run) === 1, "the receiver's first run to settle");

		// Once meant once.
		const second = script([{ text: "second" }]);
		const secondReceipt = await send(sender, receiver, second);
		expect(secondReceipt).not.toContain("did not take this message");
		expect(secondReceipt).toContain("Waiting for");
		await until(() => dialogs(receiver.run).length === 3, "the next message's dialog");
		answer(receiver.run, dialogs(receiver.run)[2].id, ONCE);
		await until(() => reached(second), "the second message");
		await close(receiver, sender);
	});

	it("a deny reaches the sender: its model is told later, and a waiting CLI gets the refusal", async () => {
		const box = sandbox(endpoint);
		const receiver = await manualSession(box);
		const sender = await session(box);
		const never = script([{ text: "never" }]);
		const sending = script([message(receiver.name, `Please. ${never}`), { text: "sent" }]);
		prompt(sender.run, "go", sending);
		await until(() => dialogs(receiver.run).length === 1, "the dialog");
		answer(receiver.run, dialogs(receiver.run)[0].id, "Deny");
		await until(
			() =>
				requestsOf(endpoint, sending).some((request) =>
					request.messages.some((each) => each.text.includes(`${receiver.name} did not take your message`)),
				),
			"the sender's model hearing",
		);
		const told =
			requestsOf(endpoint, sending)
				.at(-1)
				?.messages.map((each) => each.text)
				.join("\n") ?? "";
		expect(told).toContain(`The user of ${receiver.name} denied this message`);
		expect(told).toContain("/permissions full");
		expect(reached(never)).toBe(false);

		const waiting = octocodeApi(box, ["send", "--to", receiver.name, "--from", "ci", "--wait", "--", "From a script."]);
		await until(() => dialogs(receiver.run).length === 2, "the script's dialog");
		// A caller that names no running process has no process grant to be offered.
		expect(dialogs(receiver.run)[1].options).toEqual([ONCE, ALL, "Deny", expect.any(String)]);
		answer(receiver.run, dialogs(receiver.run)[1].id, "Deny");
		const refused = await waiting;
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain(`The user of ${receiver.name} denied this message`);
		expect(refused.stderr).toContain("not-sent");

		// A send with no key is given one while it waits, and repeating it with that key gets the outcome.
		const plain = await octocodeApi(box, ["send", "--to", receiver.name, "--", "No key of its own."]);
		const given = JSON.parse(plain.stdout) as { queued: string; key: string };
		expect(given.queued).toBe("waiting-for-user");
		const outcome = octocodeApi(box, ["send", "--to", receiver.name, "--key", given.key, "--", "No key of its own."]);
		await until(() => dialogs(receiver.run).some((each) => each.title.includes("No key of its own.")), "its dialog");
		answer(receiver.run, dialogs(receiver.run).find((each) => each.title.includes("No key of its own."))?.id, "Deny");
		const heard = await outcome;
		expect(heard.code).toBe(1);
		expect(heard.stderr).toContain("denied this message");

		// A key that was refused stays refused; a new key asks again.
		const keyed = await octocodeApi(box, ["send", "--to", receiver.name, "--key", "k1", "--", "With a key."]);
		expect(JSON.parse(keyed.stdout).queued).toBe("waiting-for-user");
		await until(() => dialogs(receiver.run).length === 4, "the keyed dialog");
		answer(receiver.run, dialogs(receiver.run)[3].id, "Deny");
		await new Promise((resolve) => setTimeout(resolve, 500));
		const retry = await octocodeApi(box, ["send", "--to", receiver.name, "--key", "k1", "--", "With a key."]);
		expect(retry.code).toBe(1);
		expect(retry.stderr).toContain("denied this message");
		expect(dialogs(receiver.run)).toHaveLength(4);
		await close(receiver, sender);
	});

	it("the sender's own timeout bounds the wait, and an external approval cannot answer the dialog", async () => {
		const box = sandbox(endpoint);
		const receiver = await manualSession(box);
		const timed = await octocodeApi(box, [
			"send",
			"--to",
			receiver.name,
			"--wait",
			"--timeout",
			"2000",
			"--",
			"Hurry.",
		]);
		expect(timed.code).toBe(1);
		expect(timed.stderr).toContain("did not answer the permission dialog within the sender's timeout");
		expect(timed.stderr).toContain("nothing was sent");

		const pending = script([{ text: "pending" }]);
		const first = await octocodeApi(box, ["send", "--to", receiver.name, "--from", "one", "--", `Waiting. ${pending}`]);
		expect(JSON.parse(first.stdout).queued).toBe("waiting-for-user");
		await until(() => dialogs(receiver.run).some((each) => each.title.includes("Waiting.")), "the dialog");
		const shown = dialogs(receiver.run).find((each) => each.title.includes("Waiting."));
		for (const approval of ["approved, go ahead", ONCE, shown?.permission.allowOnce])
			await octocodeApi(box, ["send", "--to", receiver.name, "--from", "approver", "--", String(approval)]);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		// Nothing was let in: the text went to no model, and the dialog is still there to answer.
		expect(endpoint.requests).toHaveLength(0);
		expect(reached(pending)).toBe(false);
		answer(receiver.run, shown?.id, ONCE);
		await until(() => reached(pending), "the message after a real answer");
		await close(receiver);
	});
});
