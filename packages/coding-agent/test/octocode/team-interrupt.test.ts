import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import octocode from "../../src/octocode/index.ts";
import { INTERNAL_MESSAGE_TYPE, USER_SENDER } from "../../src/octocode/shared/messages.ts";
import { agentsCommand } from "../../src/octocode/subagents/command.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** The marker a delivery carries when it stopped the receiver's step; a parent is not the user, so the unverified variant. */
const interruptNotice = renderPrompt("notices/mail/interrupt.md", { fromUser: false }).trim();

const repo = () => {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, ".git"));
	return dir;
};

const teams: Team[] = [];
const stores: TeamStore[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const team of teams.splice(0)) team.stop();
	for (const store of stores.splice(0)) store.close();
});

function agent(
	db: string,
	cwd: string,
	env: Record<string, string> = {},
	/** `running: false` with `idle: false` is a session busy without a run of its own, as during a manual compaction. */
	options: { hasUI?: boolean; idle?: boolean; running?: boolean } = {},
) {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db, ...env });
	registerCollab(fake.api, team);
	const ctx = fakeCtx({ cwd, hasUI: options.hasUI ?? true, idle: options.idle ?? true });
	// A run in progress has a signal (the host's `ctx.signal`); an idle or compacting session has none.
	if (options.idle === false && options.running !== false) ctx.signal = new AbortController().signal;
	const abort = vi.spyOn(ctx, "abort");
	team.start(ctx);
	teams.push(team);
	return { ...fake, team, ctx, abort };
}

/** A parent session and one headless subagent it started, busy unless `idle`. */
function family(idle = false) {
	const cwd = repo();
	const db = path.join(tmp(), "team.sqlite");
	const parent = agent(db, cwd);
	const parentId = parent.team.join().id;
	const child = agent(
		db,
		cwd,
		{ OCTOCODE_AGENT_ID: "general-777777", OCTOCODE_PARENT_ID: parentId },
		{ hasUI: false, idle },
	);
	child.team.join();
	const store = TeamStore.open(cwd, db);
	stores.push(store);
	return { cwd, db, parent, parentId, child, store };
}

const mail = (sent: Array<{ message: any; options: any }>) =>
	sent.filter(
		(entry) =>
			entry.message.customType === INTERNAL_MESSAGE_TYPE &&
			entry.message.details?.messages?.some((m: { id?: number }) => typeof m.id === "number"),
	);

describe("interrupt", () => {
	it("retries a held interrupt whose settlement handoff rejects asynchronously", async () => {
		const cwd = repo();
		const db = path.join(tmp(), "team.sqlite");
		const parent = agent(db, cwd);
		const parentId = parent.team.join().id;
		const child = agent(db, cwd, { OCTOCODE_AGENT_ID: "general-async", OCTOCODE_PARENT_ID: parentId }, { idle: false });
		child.team.join();
		const { id } = (await parent.team.send(child.team.id, "redirect", {
			replyRequired: false,
			interrupt: true,
		})) as { id: number };
		await vi.waitFor(() => expect(child.abort).toHaveBeenCalledTimes(1));
		const send = vi.spyOn(child.api.session, "sendMessage").mockRejectedValueOnce(new Error("turn refused"));
		await child.emit("agent_settled", {}, child.ctx);
		vi.spyOn(child.ctx, "isIdle").mockReturnValue(true);
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
		const retried = mail(child.sent);
		expect(retried).toHaveLength(1);
		await child.emit(
			"context",
			{ messages: [{ role: "custom", customType: INTERNAL_MESSAGE_TYPE, details: retried[0].message.details }] },
			child.ctx,
		);
		const store = TeamStore.open(cwd, db);
		stores.push(store);
		expect(store.recent().find((entry) => entry.id === id)?.state).toBe("delivered");
	});

	it("retries held mail when an interactive session temporarily refuses the settlement send", async () => {
		const cwd = repo();
		const db = path.join(tmp(), "team.sqlite");
		const parent = agent(db, cwd);
		const parentId = parent.team.join().id;
		const child = agent(db, cwd, { OCTOCODE_AGENT_ID: "general-retry", OCTOCODE_PARENT_ID: parentId }, { idle: false });
		child.team.join();
		const { id } = (await parent.team.send(child.team.id, "redirect", {
			replyRequired: false,
			interrupt: true,
		})) as { id: number };
		await vi.waitFor(() => expect(child.abort).toHaveBeenCalledTimes(1));
		vi.spyOn(child.api.session, "sendMessage").mockImplementationOnce(() => {
			throw new Error("session not ready");
		});
		await child.emit("agent_settled", {}, child.ctx);
		expect(mail(child.sent)).toHaveLength(0);
		vi.spyOn(child.ctx, "isIdle").mockReturnValue(true);
		await vi.waitFor(() => expect(mail(child.sent)).toHaveLength(1));
		await child.emit(
			"context",
			{
				messages: [{ role: "custom", customType: INTERNAL_MESSAGE_TYPE, details: mail(child.sent)[0].message.details }],
			},
			child.ctx,
		);
		const store = TeamStore.open(cwd, db);
		stores.push(store);
		expect(store.recent().find((entry) => entry.id === id)?.state).toBe("delivered");
	});

	it("is stored with the delivery and always wakes", () => {
		const { child, store, parentId } = family();
		store.send(parentId, [child.team.id!], "stop", { replyRequired: false, interrupt: true });
		const [message] = store.pending(child.team.id!);
		expect(message).toMatchObject({ interrupt: true, wake: true });
	});

	it("reaches only subagents the sender started, or any subagent when the user sends it", async () => {
		const { cwd, db, parent, parentId, child, store } = family();
		const peer = agent(db, cwd);
		const peerId = peer.team.join().id;
		// The peer's own tree: a subagent it started, and one that subagent started.
		const theirs = agent(db, cwd, { OCTOCODE_AGENT_ID: "general-666666", OCTOCODE_PARENT_ID: peerId });
		theirs.team.join();
		const nested = agent(db, cwd, { OCTOCODE_AGENT_ID: "general-444444", OCTOCODE_PARENT_ID: "general-666666" });
		nested.team.join();
		expect(await peer.team.send(child.team.id, "stop", { interrupt: true })).toEqual({
			error: expect.stringContaining("only a subagent you started"),
		});
		expect(await parent.team.send(peer.team.id, "stop", { interrupt: true })).toEqual({
			error: expect.stringContaining("only a subagent you started"),
		});
		// A subagent cannot stop the agent that started it, by name or by broadcast.
		expect(await child.team.send("parent", "stop", { interrupt: true })).toEqual({
			error: expect.stringContaining(`only a subagent you started; ${parentId} is not one`),
		});
		expect(await child.team.send("all", "stop", { interrupt: true })).toEqual({
			error: expect.stringContaining(`only subagents you started; ${parentId} is not one`),
		});
		// One target the sender did not start refuses the whole broadcast, its own subagent included.
		expect(await peer.team.send("all", "stop", { interrupt: true })).toEqual({
			error: expect.stringContaining("only subagents you started; general-444444 is not one"),
		});
		// Every refusal stored nothing: no recipient has mail waiting, and no message was recorded.
		for (const id of [parentId, peerId, child.team.id!, "general-666666", "general-444444"])
			expect(store.pending(id)).toEqual([]);
		expect(store.recent()).toEqual([]);
		// A broadcast interrupt reaches only the sender's tree, here its one subagent.
		expect(await parent.team.send("all", "stop", { interrupt: true })).toMatchObject({ sent: [child.team.id] });
		expect(await parent.team.send(child.team.id, "stop", { interrupt: true })).toMatchObject({
			sent: [child.team.id],
		});
		expect(await parent.team.send(child.team.id, "redirect", { from: USER_SENDER, interrupt: true })).toMatchObject({
			sent: [child.team.id],
		});
	});

	it("stops a busy subagent's current step and continues the same run with the message once it settles", async () => {
		const { parent, child, store } = family(false);
		const { id } = (await parent.team.send(child.team.id, "stop, use the v2 API instead", {
			replyRequired: false,
			interrupt: true,
		})) as { id: number };
		await vi.waitFor(() => expect(child.abort).toHaveBeenCalledTimes(1));
		// Not steered: a queued steer would only be read after the running tool finished.
		expect(mail(child.sent)).toEqual([]);
		await child.emit("agent_settled", {}, child.ctx);
		const [continued] = mail(child.sent);
		expect(continued.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(continued.message.content).toContain("stop, use the v2 API instead");
		// It stays in the team for the continued run instead of leaving.
		expect(parent.team.members().map((member) => member.id)).toContain(child.team.id);
		await child.emit(
			"context",
			{ messages: [{ role: "custom", customType: INTERNAL_MESSAGE_TYPE, details: continued.message.details }] },
			child.ctx,
		);
		expect(store.recent().find((entry) => entry.id === id)?.state).toBe("delivered");
		// The continued run's own settle ends it as usual.
		await child.emit("agent_settled", {}, child.ctx);
		expect(parent.team.members().map((member) => member.id)).not.toContain(child.team.id);
	});

	it("signals a held interrupt, so a wait for background work at the end of the run can stop early", async () => {
		const { parent, child } = family(false);
		expect(child.team.interrupted.aborted).toBe(false);
		await parent.team.send(child.team.id, "stop waiting", { replyRequired: false, interrupt: true });
		await vi.waitFor(() => expect(child.team.interrupted.aborted).toBe(true));
		await child.emit("agent_settled", {}, child.ctx);
		// A fresh signal for the next interrupt.
		expect(child.team.interrupted.aborted).toBe(false);
	});

	it("ends a subagent's wait for background work at the end of its run", async () => {
		const cwd = repo();
		const db = path.join(tmp(), "team.sqlite");
		vi.stubEnv("OCTOCODE_HOME", tmp());
		vi.stubEnv("OCTOCODE_AGENT_DB", db);
		vi.stubEnv("OCTOCODE_AGENT_ID", "general-121212");
		vi.stubEnv("OCTOCODE_PARENT_ID", "main-aaaaaa");
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd, hasUI: false, idle: false });
		try {
			await octocode(fake.api);
			await fake.emit("session_start", { type: "session_start" }, ctx);
			await fake.tools
				.get("bash")
				.execute("t1", { command: "sleep 30", background: true, timeout: 60 }, undefined, undefined, ctx);
			const store = TeamStore.open(cwd, db);
			stores.push(store);
			store.save({
				id: "main-aaaaaa",
				role: "main",
				pid: process.pid,
				status: "working",
				joinedAt: 1,
				updatedAt: Date.now(),
				toolCalls: 0,
				input: 0,
				cacheRead: 0,
				output: 0,
				cost: 0,
				unpriced: false,
			});
			store.send("main-aaaaaa", ["general-121212"], "stop waiting, new plan", {
				replyRequired: false,
				interrupt: true,
			});
			const started = Date.now();
			await fake.emit(
				"agent_before_settle",
				{
					type: "agent_before_settle",
					outcome: "completed",
					entries: [],
					context: { llmMessages: [] },
					continue: false,
				},
				ctx,
			);
			expect(Date.now() - started).toBeLessThan(8_000);
		} finally {
			await fake.emit("session_shutdown", { type: "session_shutdown" }, ctx);
		}
	}, 20_000);

	it("says the step was stopped only when it was", async () => {
		const { cwd, db, parent, parentId, child } = family(false);
		await parent.team.send(child.team.id, "switch tasks", { replyRequired: false, interrupt: true });
		await vi.waitFor(() => expect(child.abort).toHaveBeenCalled());
		await child.emit("agent_settled", {}, child.ctx);
		expect(mail(child.sent)[0].message.content).toContain(interruptNotice);
		// One with a UI that is idle is woken, not stopped.
		const ui = agent(
			db,
			cwd,
			{ OCTOCODE_AGENT_ID: "general-999999", OCTOCODE_PARENT_ID: parentId },
			{ hasUI: true, idle: true },
		);
		ui.team.join();
		await parent.team.send(ui.team.id, "new direction", { replyRequired: false, interrupt: true });
		await vi.waitFor(() => expect(mail(ui.sent)).toHaveLength(1));
		expect(mail(ui.sent)[0].message.content).not.toContain("was stopped");
		expect(ui.abort).not.toHaveBeenCalled();
	});

	it("delivers an interrupt as a plain waking message when the session cannot abort", async () => {
		const { parent, child } = family(false);
		child.abort.mockImplementation(() => {
			throw new Error("session ended");
		});
		await parent.team.send(child.team.id, "stop", { replyRequired: false, interrupt: true });
		await vi.waitFor(() => expect(mail(child.sent)).toHaveLength(1));
		expect(mail(child.sent)[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(child.team.interrupted.aborted).toBe(false);
	});

	it("lets the user interrupt only subagents of this session", async () => {
		const { cwd, db, child } = family();
		const other = agent(db, cwd);
		const otherId = other.team.join().id;
		const theirs = agent(
			db,
			cwd,
			{ OCTOCODE_AGENT_ID: "general-555555", OCTOCODE_PARENT_ID: otherId },
			{ hasUI: false, idle: false },
		);
		theirs.team.join();
		expect(await other.team.send(child.team.id, "stop", { from: USER_SENDER, interrupt: true })).toEqual({
			error: expect.stringContaining("only a subagent of this session"),
		});
		expect(await other.team.send(theirs.team.id, "stop", { from: USER_SENDER, interrupt: true })).toMatchObject({
			sent: [theirs.team.id],
		});
	});

	it("delivers to an agent with a UI that is idle as a waking message, without aborting", async () => {
		const cwd = repo();
		const db = path.join(tmp(), "team.sqlite");
		const parent = agent(db, cwd);
		const parentId = parent.team.join().id;
		const child = agent(
			db,
			cwd,
			{ OCTOCODE_AGENT_ID: "general-888888", OCTOCODE_PARENT_ID: parentId },
			{ hasUI: true, idle: true },
		);
		child.team.join();
		await parent.team.send(child.team.id, "new direction", { replyRequired: false, interrupt: true });
		await vi.waitFor(() => expect(mail(child.sent)).toHaveLength(1));
		expect(mail(child.sent)[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(child.abort).not.toHaveBeenCalled();
	});

	it("delivers a held interrupt once the session is idle when no run settles, as after a manual /compact", async () => {
		const cwd = repo();
		const db = path.join(tmp(), "team.sqlite");
		const parent = agent(db, cwd);
		const parentId = parent.team.join().id;
		// Busy only with a compaction: Octocode's isIdle is false and no agent run is there to settle. A peer's stop request
		// does not cancel the compaction (only the user's Stop does), so the mail waits until the session reports idle.
		const child = agent(
			db,
			cwd,
			{ OCTOCODE_AGENT_ID: "general-compact", OCTOCODE_PARENT_ID: parentId },
			{ idle: false, running: false },
		);
		child.team.join();
		await parent.team.send(child.team.id, "drop the compaction, do this", { replyRequired: false, interrupt: true });
		await vi.waitFor(() => expect(child.abort).toHaveBeenCalledTimes(1));
		// Asked to stop as a peer, the reason that leaves a running compaction alone.
		expect(child.abort).toHaveBeenCalledWith("peer");
		expect(mail(child.sent)).toHaveLength(0);
		vi.spyOn(child.ctx, "isIdle").mockReturnValue(true);
		await vi.waitFor(() => expect(mail(child.sent)).toHaveLength(1));
		// No step was running, so none was stopped: the one delivery carries the message without the marker.
		expect(mail(child.sent)[0].message.content).not.toContain(interruptNotice);
		expect(mail(child.sent)[0].message.content).not.toContain("was stopped");
		expect(mail(child.sent)[0].message.content).toContain("drop the compaction, do this");
		expect(mail(child.sent)[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(child.abort).toHaveBeenCalledTimes(1);
	});

	it("is offered by the sendMessage tool and /agents interrupt", async () => {
		const { parent, child } = family(false);
		const send = parent.tools.get("sendMessage");
		expect(Object.keys(send.parameters.properties)).toContain("interrupt");
		const result = await send.execute(
			"c",
			{ to: child.team.id, message: "stop", interrupt: true },
			undefined,
			undefined,
			parent.ctx,
		);
		expect(result.content[0].text).toMatch(/^Interrupt queued for general-777777 as message #\d+:.*within a second\.$/);
		const command = agentsCommand(parent.team, new Map());
		await command.handler(`interrupt ${child.team.id} switch to the docs task`, parent.ctx);
		expect(parent.ctx.ui.notes.at(-1)).toEqual({ message: "Interrupt queued for general-777777", type: "info" });
		await command.handler("interrupt", parent.ctx);
		expect(parent.ctx.ui.notes.at(-1)).toEqual({
			message: "Usage: /agents interrupt <id> <message>",
			type: "warning",
		});
		expect(command.complete!("int")).toEqual([expect.objectContaining({ value: "interrupt " })]);
	});
});
