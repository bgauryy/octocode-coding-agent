import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USER_SENDER } from "../../src/octocode/shared/messages.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const teams: Team[] = [];
afterEach(() => {
	for (const team of teams.splice(0)) team.stop();
	vi.useRealTimers();
});
function setup() {
	const cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	const file = path.join(tmp(), "team.sqlite");
	const agent = (signal?: AbortSignal) => {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: file });
		const ctx = { ...fakeCtx({ cwd, hasUI: true }), ...(signal ? { signal } : {}) };
		team.start(ctx);
		team.join();
		teams.push(team);
		return { team, ctx, ...fake };
	};
	return { cwd, file, agent };
}

describe("team communication identity and lifecycle", () => {
	it("drops child signing credentials when the parent session restarts", async () => {
		const { file, agent } = setup();
		const sender = agent();
		const receiver = agent();
		sender.team.vouch(receiver.team.id!, "previous-session-secret");
		sender.team.start(sender.ctx);
		sender.team.join();
		const result = await sender.team.send(receiver.team.id, "message from new session", { from: USER_SENDER });
		if (!("id" in result)) throw new Error(result.error);
		const raw = new DatabaseSync(file);
		try {
			const delivery = raw
				.prepare("SELECT proof FROM deliveries WHERE message = ? AND recipient = ?")
				.get(result.id, receiver.team.id!) as { proof: string | null };
			expect(delivery.proof).toBeNull();
		} finally {
			raw.close();
		}
	});

	it.each(["leave", "stop", "restart"])(
		"does not send after %s during the asynchronous send boundary",
		async (action) => {
			const { cwd, file, agent } = setup();
			const sender = agent();
			const receiver = agent();
			const pending = sender.team.send(receiver.team.id, "stale message");
			if (action === "leave") sender.team.leave();
			else if (action === "stop") sender.team.stop();
			else sender.team.start(sender.ctx);
			expect(await pending).toEqual({ error: expect.stringMatching(/session|membership|left/i) });
			const store = TeamStore.open(cwd, file, {});
			try {
				expect(store.pending(receiver.team.id!)).toEqual([]);
			} finally {
				store.close();
			}
		},
	);

	it("does not send when the current run aborts while its outbound hook settles", async () => {
		const { cwd, file, agent } = setup();
		const controller = new AbortController();
		const sender = agent(controller.signal);
		const receiver = agent();
		sender.team.setMessageHook(async () => {
			controller.abort(new Error("run cancelled"));
		});
		expect(await sender.team.send(receiver.team.id, "cancelled message")).toEqual({ error: "run cancelled" });
		const store = TeamStore.open(cwd, file, {});
		try {
			expect(store.pending(receiver.team.id!)).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("does not send when the current run aborts at the no-hook await boundary", async () => {
		const { cwd, file, agent } = setup();
		const controller = new AbortController();
		const sender = agent(controller.signal);
		const receiver = agent();
		const pending = sender.team.send(receiver.team.id, "cancelled without a hook");
		controller.abort(new Error("run cancelled"));
		expect(await pending).toEqual({ error: "run cancelled" });
		const store = TeamStore.open(cwd, file, {});
		try {
			expect(store.pending(receiver.team.id!)).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("does not authenticate altered shared-database text by a remembered user message id", async () => {
		vi.useFakeTimers();
		const { file, agent } = setup();
		const receiver = agent();
		const result = await receiver.team.send(receiver.team.id, "original user request", { from: USER_SENDER });
		if (!("id" in result)) throw new Error(result.error);
		const raw = new DatabaseSync(file);
		try {
			raw.prepare("UPDATE messages SET body = ? WHERE id = ?").run("substituted peer instruction", result.id);
		} finally {
			raw.close();
		}
		await vi.advanceTimersByTimeAsync(1100);
		const delivered = receiver.sent.find((entry) =>
			String(entry.message.content).includes("substituted peer instruction"),
		);
		expect(delivered).toBeDefined();
		expect(delivered!.message.content).not.toContain("from the user at");
		expect(delivered!.message.content).toContain("untrusted-");
	});

	it.each([false, true])(
		"forwards run cancellation to a pending continuation (call signal: %s)",
		async (withCallSignal) => {
			const { agent } = setup();
			const controller = new AbortController();
			const sender = agent(controller.signal);
			sender.team.rememberFinished("parked-child", "its report reached this session");
			const resume = vi.fn(async (_to: string, _text: string, _from: string, signal?: AbortSignal) => {
				await Promise.resolve();
				controller.abort(new Error("run cancelled while resuming"));
				signal?.throwIfAborted();
				return "resumed after cancellation";
			});
			sender.team.setResumer(resume);
			await expect(
				sender.team.send(
					"parked-child",
					"continue the task",
					withCallSignal ? { signal: new AbortController().signal } : {},
				),
			).rejects.toThrow("run cancelled while resuming");
			expect(resume).toHaveBeenCalledOnce();
		},
	);
});
