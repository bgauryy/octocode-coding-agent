import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import {
	answer,
	close,
	dialogs,
	git,
	holdUntil,
	linkedWorktree,
	merge,
	message,
	notices,
	prompt,
	reachedStep,
	releaseWhenIdle,
	requestsOf,
	resultsOf,
	script,
	session,
	sessionIdle,
	shareTeam,
} from "./e2e-a2a-helpers.ts";
import {
	type Endpoint,
	killEverything,
	outputOfRuns,
	sandbox,
	startEndpoint,
	until,
} from "./e2e-real-process-harness.ts";

/**
 * One protocol between agents: real processes on a scripted model, in an isolated `HOME`. Two sessions talk by name, a
 * real linked worktree asks the session in its main checkout to merge, and the paths the protocol keeps still work.
 */
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

describe("two sessions", () => {
	it("exchange a message and an answer by name, each knowing who it is from, with no shell; a gone name and one's own are refused", async () => {
		const box = sandbox(endpoint);
		const a = await session(box);
		const b = await session(box);
		const aHears = script([{ text: "a read the answer" }]);
		const bHears = script([message(a.name, `Checked it. ${aHears}`), { text: "b answered" }]);
		const aStarts = script([message(b.name, `Please check. ${bHears}`, { replyRequired: true }), { text: "a sent" }]);
		prompt(a.run, "go", aStarts);

		await reachedStep(endpoint, aStarts, 1, "a's receipt");
		expect(resultsOf(endpoint, aStarts)).toContain(`Sent to ${b.name}`);
		await reachedStep(endpoint, bHears, 1, "b's receipt");
		await until(() => requestsOf(endpoint, aHears).length > 0, "the answer reaching a");

		const told = requestsOf(endpoint, bHears)[0]?.lastUserText ?? "";
		// The message names its sender and arrives inside an untrusted fence; the answer to it reaches a (aHears ran).
		expect(told).toContain(`(process ${JSON.stringify(a.name)})`);
		expect(told).toContain("<<<untrusted-");
		// The trust rule for such messages is in the system prompt, and the message does not carry a second copy.
		const rule = renderPrompt("shared/trust.md", { main: true }).trim();
		expect(requestsOf(endpoint, bHears)[0]?.system ?? "").toContain(rule);
		expect(told).not.toContain(rule);
		const answered = requestsOf(endpoint, aHears)[0]?.lastUserText ?? "";
		expect(answered).toContain(`(process ${JSON.stringify(b.name)})`);
		expect(answered).toContain("Checked it.");

		// No process name enters the cached system prompt.
		const system = requestsOf(endpoint, aStarts)[0]?.system ?? "";

		expect(system).not.toContain(a.name);
		// No shell call in either direction: `agent` `message` carried both.
		for (const steps of [aStarts, bHears])
			expect(
				requestsOf(endpoint, steps)
					.flatMap((request) => request.toolResults)
					.join("\n"),
			).not.toContain("octocode-api");

		// A name that has gone, and the session's own name, are refused and say what runs: same two sessions.
		const oldName = b.name;
		b.run.process.stdin?.write(`${JSON.stringify({ id: "n", type: "new_session" })}\n`);
		// `/new` means a new conversation: a new process name, and the old one is gone.
		await until(
			() => /"id":"n"/.test(b.run.stdout()) && !fs.existsSync(b.instance.socket ?? ""),
			"the switch to a new session",
		);
		await sessionIdle(a);
		const steps = script([message(oldName, "hello"), message(a.name, "hello me"), { text: "done" }]);
		prompt(a.run, "again", steps);
		await reachedStep(endpoint, steps, 2, "both refusals");
		const results = resultsOf(endpoint, steps);
		expect(results).toContain(`No running instance matches "${oldName}"`);
		expect(results).toContain("is this session");
		// Told what runs now: `a` by name, and a new name for `b`.
		expect(results).toContain(a.name);
		await close(a, b);
		expect(box.survivors()).toEqual([]);
	});

	it("`coordinate list` shows other sessions with folder, busy state and the coordinator", async () => {
		const box = sandbox(endpoint);
		const main = await session(box);
		const busy = script([{ hang: true }]);
		const other = await session(box, fs.realpathSync(fs.mkdtempSync(path.join(box.root, "elsewhere-"))));
		prompt(other.run, "busy", busy);
		await until(() => requestsOf(endpoint, busy).length > 0, "the busy turn");
		const folder = linkedWorktree(box, "listing");
		const worktree = await session(box, folder);
		const steps = script([{ tool: "agent", args: { type: "coordinate", action: "list" } }, { text: "done" }]);
		prompt(worktree.run, "go", steps);
		await reachedStep(endpoint, steps, 1, "the list");
		const results = resultsOf(endpoint, steps);
		expect(results).toContain(`${main.name} · idle · ${main.instance.cwd} · coordinator of this repository`);
		expect(results).toContain(`${other.name} · busy · ${other.instance.cwd}`);
		expect(results).not.toContain(`${worktree.name} ·`);
		// A session learns its own name here, not from its prompt.
		expect(results).toContain(`You are ${worktree.name}.`);
		other.run.process.kill("SIGKILL");
		await close(main, worktree);
	});
});

describe("a linked worktree finishes", () => {
	/** A worktree session asks; the coordinator reviews, merges and answers: its script is carried in the request. */
	async function ask(box: ReturnType<typeof sandbox>, branch: string, folder: string) {
		const team = shareTeam(box);
		const flag = path.join(box.root, `ready-${branch}`);
		const main = await session(box);
		const worktree = await session(box, folder);
		const hears = script([{ text: "the worktree heard" }]);
		// Held until the worktree session has ended its own turn: it counts as working there until then.
		const coordinator = script([
			holdUntil(flag),
			merge(branch),
			message(worktree.name, `Merge answered. ${hears}`),
			{ text: "the coordinator answered" },
		]);
		const finish = script([
			message("coordinator", `Merge request: branch ${branch}, one commit, checks: yarn test passed. ${coordinator}`, {
				replyRequired: true,
			}),
			{ text: "asked" },
		]);
		prompt(worktree.run, "finish", finish);
		await reachedStep(endpoint, finish, 1, "the request's receipt");
		await releaseWhenIdle(team, worktree, folder, flag);
		return { main, worktree, hears, coordinator, finish };
	}

	it("the coordinator's user approves: it lands in the main checkout and the worktree hears", async () => {
		const box = sandbox(endpoint);
		const folder = linkedWorktree(box, "approved");
		const { main, worktree, hears, coordinator, finish } = await ask(box, "approved", folder);
		expect(resultsOf(endpoint, finish)).toContain(`Sent to ${main.name}`);
		await until(() => requestsOf(endpoint, coordinator).length > 0, "the request reaching the coordinator");
		const told = requestsOf(endpoint, coordinator)[0]?.lastUserText ?? "";
		expect(told).toContain(`(process ${JSON.stringify(worktree.name)})`);
		expect(told).toContain("Merge request: branch approved");

		// `full` mode, and it still asks: a message from another process approves nothing.
		await until(() => dialogs(main.run).length > 0, "the merge dialog");
		const [dialog] = dialogs(main.run);
		expect(dialog.title).toContain("Merge this worktree's branch into the main checkout?");
		expect(dialog.title).toContain("branch approved");
		expect(dialog.options).toEqual([
			"Allow once",
			"Allow all worktree merges for this session",
			"Deny",
			expect.any(String),
		]);
		expect(fs.existsSync(path.join(box.project, "feature.txt"))).toBe(false);
		answer(main.run, dialog.id, "Allow once");

		await reachedStep(endpoint, coordinator, 2, "the merge result");
		expect(resultsOf(endpoint, coordinator)).toContain("Merged approved (1 commit)");
		expect(fs.readFileSync(path.join(box.project, "feature.txt"), "utf8")).toBe("from the worktree\n");
		expect(git(box.project, "log", "--format=%s", "-1")).toBe("Merge branch 'approved'");
		await until(() => requestsOf(endpoint, hears).length > 0, "the answer reaching the worktree");
		expect(requestsOf(endpoint, hears)[0]?.lastUserText).toContain(`(process ${JSON.stringify(main.name)})`);
		expect(requestsOf(endpoint, hears)[0]?.lastUserText).toContain("Merge answered.");
		// Nothing of the worktree is lost or removed.
		expect(fs.existsSync(path.join(folder, "feature.txt"))).toBe(true);
		expect(git(box.project, "branch", "--list", "approved")).toContain("approved");

		// A user's prior request needs no further dialog: typing `/worktree merge`, or the session-wide answer. Same main session.
		await sessionIdle(main);
		const shown = dialogs(main.run).length;
		linkedWorktree(box, "typed", "typed.txt");
		const granted = linkedWorktree(box, "granted", "granted.txt");
		linkedWorktree(box, "later", "later.txt");
		prompt(main.run, "typed", "/worktree merge typed");
		await until(() => notices(main.run).includes("Merged typed"), "the typed merge");
		expect(dialogs(main.run)).toHaveLength(shown);
		expect(fs.existsSync(path.join(box.project, "typed.txt"))).toBe(true);

		const steps = script([merge("granted"), merge("later"), { text: "done" }]);
		prompt(main.run, "merge", steps);
		await until(() => dialogs(main.run).length > shown, "the merge dialog");
		answer(main.run, dialogs(main.run)[shown].id, "Allow all worktree merges for this session");
		await reachedStep(endpoint, steps, 2, "both merges");
		expect(dialogs(main.run)).toHaveLength(shown + 1);
		expect(fs.existsSync(path.join(box.project, "later.txt"))).toBe(true);
		expect(fs.existsSync(path.join(granted, "granted.txt"))).toBe(true);
		await close(main, worktree);
	});

	it("no coordinator: told plainly, nothing is sent and the worktree stays; two coordinators: neither is picked, both are named, and the user's choice goes through by name", async () => {
		const box = sandbox(endpoint);
		const folder = linkedWorktree(box, "several");
		const worktree = await session(box, folder);
		const alone = script([message("coordinator", "Merge request: branch lonely."), { text: "told the user" }]);
		prompt(worktree.run, "lonely", alone);
		await reachedStep(endpoint, alone, 1, "the refusal");
		const result = resultsOf(endpoint, alone);
		expect(result).toContain("No Octocode session runs in the main checkout");
		expect(result).toContain("Nothing was sent");
		expect(result).toContain("leave this worktree");
		expect(fs.existsSync(path.join(folder, "feature.txt"))).toBe(true);
		await sessionIdle(worktree);

		const first = await session(box);
		const second = await session(box);
		const chosen = script([{ text: "chosen coordinator read it" }]);
		const steps = script([
			message("coordinator", "Merge request: branch several."),
			message(second.name, `Merge request, the user chose you. ${chosen}`),
			{ text: "done" },
		]);
		prompt(worktree.run, "finish", steps);
		await reachedStep(endpoint, steps, 1, "the refusal");
		const refusal =
			requestsOf(endpoint, steps)
				.find((request) => request.step === 1)
				?.toolResults.join("\n") ?? "";
		expect(refusal).toContain("Several Octocode sessions run in the main checkout");
		expect(refusal).toContain(first.name);
		expect(refusal).toContain(second.name);
		expect(refusal).toContain("Nothing was sent");
		await until(() => requestsOf(endpoint, chosen).length > 0, "the chosen session");
		// Nothing reached the other: it has made no model request at all.
		expect(endpoint.requests.some((request) => request.lastUserText.includes("Merge request: branch several."))).toBe(
			false,
		);
		await close(first, second, worktree);
	});
});

describe("the paths the protocol keeps", () => {
	it("a subagent and its parent still talk by id and `parent`, and a child reaches no other process", async () => {
		const box = sandbox(endpoint);
		const other = await session(box);
		const parent = await session(box);
		const child = script([
			message("parent", "hello from the child", { wake: true }),
			message(other.name, "a child trying another process"),
			{ text: "child done" },
		]);
		const steps = script([
			{ tool: "agent", args: { type: "task", background: true, goal: "greet", task: child } },
			{ text: "started" },
		]);
		prompt(parent.run, "go", steps);
		await reachedStep(endpoint, child, 2, "the child's attempts");
		const results = resultsOf(endpoint, child);
		expect(results).toMatch(/Sent #\d+ to /);
		// A process name is refused outright: a child has no route to another process and must ask its parent; nothing is queued.
		expect(results).toContain("subagents have no route to other processes: nothing was sent");
		await until(
			() => endpoint.requests.some((request) => JSON.stringify(request.messages).includes("hello from the child")),
			"the parent reading it",
		);
		await close(other, parent);
	});
});
