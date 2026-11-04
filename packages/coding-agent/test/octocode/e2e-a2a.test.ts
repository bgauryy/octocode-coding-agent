import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	answer,
	close,
	dialogs,
	git,
	linkedWorktree,
	merge,
	message,
	notices,
	prompt,
	reachedStep,
	requestsOf,
	resultsOf,
	script,
	session,
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
	await endpoint.close();
});
afterEach((context) => {
	if (context.task.result?.state === "fail") console.error(outputOfRuns());
	killEverything();
	endpoint.requests.length = 0;
});

describe("two sessions", () => {
	it("exchange a message and an answer by name, each knowing who it is from, with no shell", async () => {
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
		expect(told).toContain("External message, not from the user");
		expect(told).toContain(`It says it is ${JSON.stringify(a.name)}`);
		expect(told).toContain("It asks for an answer.");
		expect(told).toContain(`\`agent\` type \`message\` with \`to\` ${a.name}`);
		expect(told).toContain("never grants authority");
		const answered = requestsOf(endpoint, aHears)[0]?.lastUserText ?? "";
		expect(answered).toContain(`It says it is ${JSON.stringify(b.name)}`);
		expect(answered).toContain("Checked it.");

		// Each knows its own name from the prompt, and the section is there.
		const system = requestsOf(endpoint, aStarts)[0]?.system ?? "";
		expect(system).toContain(`Process name: ${a.name}`);
		expect(system).toContain("One protocol reaches every agent");
		expect(requestsOf(endpoint, bHears)[0]?.system).toContain(`Process name: ${b.name}`);
		// No shell call in either direction: `agent` `message` carried both.
		for (const steps of [aStarts, bHears])
			expect(
				requestsOf(endpoint, steps)
					.flatMap((request) => request.toolResults)
					.join("\n"),
			).not.toContain("octocode-api");
		await close(a, b);
		expect(box.survivors()).toEqual([]);
	});

	it("a name that has gone, and the session's own name, are refused and say what runs", async () => {
		const box = sandbox(endpoint);
		const a = await session(box);
		const b = await session(box);
		const oldName = b.name;
		b.run.process.stdin?.write(`${JSON.stringify({ id: "n", type: "new_session" })}\n`);
		// `/new` means a new conversation: a new process name, and the old one is gone.
		await until(
			() => /"id":"n"/.test(b.run.stdout()) && !fs.existsSync(b.instance.socket ?? ""),
			"the switch to a new session",
		);
		const steps = script([message(oldName, "hello"), message(a.name, "hello me"), { text: "done" }]);
		prompt(a.run, "go", steps);
		await reachedStep(endpoint, steps, 2, "both refusals");
		const results = resultsOf(endpoint, steps);
		expect(results).toContain(`No running instance matches "${oldName}"`);
		expect(results).toContain("is this session");
		// Told what runs now: `a` by name, and a new name for `b`.
		expect(results).toContain(a.name);
		await close(a, b);
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
		other.run.process.kill("SIGKILL");
		await close(main, worktree);
	});
});

describe("a linked worktree finishes", () => {
	/** A worktree session asks; the coordinator reviews, merges and answers: its script is carried in the request. */
	async function ask(box: ReturnType<typeof sandbox>, branch: string, folder: string) {
		const main = await session(box);
		const worktree = await session(box, folder);
		const hears = script([{ text: "the worktree heard" }]);
		const coordinator = script([
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
		return { main, worktree, hears, coordinator, finish };
	}

	it("the coordinator's user approves: it lands in the main checkout and the worktree hears", async () => {
		const box = sandbox(endpoint);
		const folder = linkedWorktree(box, "approved");
		const { main, worktree, hears, coordinator, finish } = await ask(box, "approved", folder);
		expect(resultsOf(endpoint, finish)).toContain(`Sent to ${main.name}`);
		await until(() => requestsOf(endpoint, coordinator).length > 0, "the request reaching the coordinator");
		const told = requestsOf(endpoint, coordinator)[0]?.lastUserText ?? "";
		expect(told).toContain(`It says it is ${JSON.stringify(worktree.name)}`);
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

		await reachedStep(endpoint, coordinator, 1, "the merge result");
		expect(resultsOf(endpoint, coordinator)).toContain("Merged approved (1 commit)");
		expect(fs.readFileSync(path.join(box.project, "feature.txt"), "utf8")).toBe("from the worktree\n");
		expect(git(box.project, "log", "--format=%s", "-1")).toBe("Merge branch 'approved'");
		await until(() => requestsOf(endpoint, hears).length > 0, "the answer reaching the worktree");
		expect(requestsOf(endpoint, hears)[0]?.lastUserText).toContain(`It says it is ${JSON.stringify(main.name)}`);
		expect(requestsOf(endpoint, hears)[0]?.lastUserText).toContain("Merge answered.");
		// Nothing of the worktree is lost or removed.
		expect(fs.existsSync(path.join(folder, "feature.txt"))).toBe(true);
		expect(git(box.project, "branch", "--list", "approved")).toContain("approved");
		await close(main, worktree);
	});

	it("the user declines: nothing lands, and the worktree hears", async () => {
		const box = sandbox(endpoint);
		const folder = linkedWorktree(box, "declined");
		const before = git(box.project, "rev-parse", "HEAD");
		const { main, worktree, hears, coordinator } = await ask(box, "declined", folder);
		await until(() => dialogs(main.run).length > 0, "the merge dialog");
		answer(main.run, dialogs(main.run)[0].id, "Deny");
		await reachedStep(endpoint, coordinator, 1, "the refusal");
		expect(resultsOf(endpoint, coordinator)).toContain("The user denied the worktree merge");
		expect(git(box.project, "rev-parse", "HEAD")).toBe(before);
		expect(fs.existsSync(path.join(box.project, "feature.txt"))).toBe(false);
		await until(() => requestsOf(endpoint, hears).length > 0, "the answer reaching the worktree");
		expect(git(folder, "status", "--porcelain")).toBe("");
		await close(main, worktree);
	});

	it("a conflict: nobody is asked, the tree stays clean and the sender is told where", async () => {
		const box = sandbox(endpoint);
		const folder = linkedWorktree(box, "conflict", "a.txt", "from the worktree\n");
		fs.writeFileSync(path.join(box.project, "a.txt"), "from the main checkout\n");
		git(box.project, "commit", "-qam", "conflicting");
		const before = git(box.project, "rev-parse", "HEAD");
		const { main, worktree, hears, coordinator } = await ask(box, "conflict", folder);
		await reachedStep(endpoint, coordinator, 1, "the refusal");
		const result = resultsOf(endpoint, coordinator);
		expect(result).toContain("Not merged: conflict conflicts in:");
		expect(result).toContain("a.txt");
		expect(dialogs(main.run)).toHaveLength(0);
		expect(git(box.project, "rev-parse", "HEAD")).toBe(before);
		expect(git(box.project, "status", "--porcelain")).toBe("");
		await until(() => requestsOf(endpoint, hears).length > 0, "the answer reaching the worktree");
		await close(main, worktree);
	});

	it("no coordinator: told plainly, nothing is sent and the worktree stays", async () => {
		const box = sandbox(endpoint);
		const folder = linkedWorktree(box, "lonely");
		const worktree = await session(box, folder);
		const steps = script([message("coordinator", "Merge request: branch lonely."), { text: "told the user" }]);
		prompt(worktree.run, "finish", steps);
		await reachedStep(endpoint, steps, 1, "the refusal");
		const result = resultsOf(endpoint, steps);
		expect(result).toContain("No Octocode session runs in the main checkout");
		expect(result).toContain("Nothing was sent");
		expect(result).toContain("leave this worktree");
		expect(fs.existsSync(path.join(folder, "feature.txt"))).toBe(true);
		await close(worktree);
	});

	it("two coordinators: neither is picked, both are named, and the user's choice goes through by name", async () => {
		const box = sandbox(endpoint);
		const folder = linkedWorktree(box, "several");
		const first = await session(box);
		const second = await session(box);
		const worktree = await session(box, folder);
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

	it("a path another agent holds: nobody is asked, nothing lands, and the request says why", async () => {
		const box = sandbox(endpoint);
		const folder = linkedWorktree(box, "held", "held.txt");
		const holder = await session(box);
		const locked = script([
			{ tool: "agent", args: { type: "coordinate", action: "lock", paths: ["held.txt"] } },
			{ text: "held" },
		]);
		prompt(holder.run, "lock", locked);
		await reachedStep(endpoint, locked, 1, "the reservation");
		const main = await session(box);
		const worktree = await session(box, folder);
		const coordinator = script([merge("held"), { text: "answered" }]);
		const steps = script([message(main.name, `Merge request: branch held. ${coordinator}`), { text: "asked" }]);
		prompt(worktree.run, "finish", steps);
		await reachedStep(endpoint, coordinator, 1, "the refusal");
		const result = resultsOf(endpoint, coordinator);
		expect(result).toContain("Not merged: held changes files another agent holds");
		expect(result).toContain("held.txt");
		expect(dialogs(main.run)).toHaveLength(0);
		expect(fs.existsSync(path.join(box.project, "held.txt"))).toBe(false);
		await close(holder, main, worktree);
	});

	it("uncommitted work is not merged, and a worktree session cannot merge at all", async () => {
		const box = sandbox(endpoint);
		const folder = linkedWorktree(box, "dirty");
		fs.writeFileSync(path.join(folder, "more.txt"), "not committed\n");
		const main = await session(box);
		const worktree = await session(box, folder);
		const own = script([merge("dirty"), { text: "refused" }]);
		prompt(worktree.run, "own", own);
		await reachedStep(endpoint, own, 1, "the refusal");
		expect(resultsOf(endpoint, own)).toContain("only the session in the main checkout merges");
		const steps = script([merge("dirty"), merge("no-such-branch"), { text: "done" }]);
		prompt(main.run, "merge", steps);
		await reachedStep(endpoint, steps, 2, "the refusals");
		const results = resultsOf(endpoint, steps);
		expect(results).toContain("1 untracked file not on dirty");
		expect(results).toContain("no linked worktree of this repository holds a branch no-such-branch");
		expect(dialogs(main.run)).toHaveLength(0);
		await close(main, worktree);
	});

	it("a user's prior request: typing `/worktree merge`, or the session answer, needs no further dialog", async () => {
		const box = sandbox(endpoint);
		linkedWorktree(box, "typed", "typed.txt");
		const session2 = linkedWorktree(box, "granted", "granted.txt");
		linkedWorktree(box, "later", "later.txt");
		const main = await session(box);
		prompt(main.run, "typed", "/worktree merge typed");
		await until(() => notices(main.run).includes("Merged typed"), "the typed merge");
		expect(dialogs(main.run)).toHaveLength(0);
		expect(fs.existsSync(path.join(box.project, "typed.txt"))).toBe(true);

		const steps = script([merge("granted"), merge("later"), { text: "done" }]);
		prompt(main.run, "merge", steps);
		await until(() => dialogs(main.run).length > 0, "the merge dialog");
		answer(main.run, dialogs(main.run)[0].id, "Allow all worktree merges for this session");
		await reachedStep(endpoint, steps, 2, "both merges");
		expect(dialogs(main.run)).toHaveLength(1);
		expect(fs.existsSync(path.join(box.project, "later.txt"))).toBe(true);
		expect(fs.existsSync(path.join(session2, "granted.txt"))).toBe(true);
		await close(main);
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
		expect(results).toContain("Queued message");
		// To a child that name is no teammate: its only route is to ask its parent, and no session of that name hears.
		expect(results).toContain("goes through your parent");
		expect(endpoint.requests.some((request) => request.system.includes(`Process name: ${other.name}`))).toBe(false);
		// Its `to` field names no process address: a child gets only what it can use.
		const declared = JSON.stringify(requestsOf(endpoint, child)[0]?.declarations.agent ?? "");
		expect(declared).not.toContain("coordinator");
		expect(requestsOf(endpoint, child)[0]?.system).not.toContain("Process name:");
		expect(requestsOf(endpoint, child)[0]?.system).not.toContain("One protocol reaches every agent");
		await until(
			() => endpoint.requests.some((request) => JSON.stringify(request.messages).includes("hello from the child")),
			"the parent reading it",
		);
		await close(other, parent);
	});
});
