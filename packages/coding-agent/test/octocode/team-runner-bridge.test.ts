import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { PARENT_FENCE_NOTE } from "../../src/octocode/shared/fence.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

function setup() {
	const cwd = tmp("runner-team-");
	fs.mkdirSync(path.join(cwd, ".git"));
	const env = { OCTOCODE_AGENT_DB: path.join(cwd, "team.sqlite") };
	const f = fakeHost(),
		team = new Team(f.api, env),
		ctx = fakeCtx({ cwd });
	team.start(ctx);
	team.join();
	const other = new Team(fakeHost().api, env);
	other.start(fakeCtx({ cwd }));
	other.join();
	const store = TeamStore.open(cwd, env.OCTOCODE_AGENT_DB, env);
	return {
		cwd,
		team,
		other,
		store,
		close: () => {
			other.stop();
			team.stop();
			store.close();
		},
	};
}

async function client(bridge: Awaited<ReturnType<Team["runnerBridge"]>>) {
	const { url, headers } = bridge.communication;
	let id = 0;
	const send = async (method: string, params: unknown, auth = true) => {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(auth ? Object.fromEntries(headers.map(({ name, value }) => [name, value])) : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
		});
		const text = await response.text();
		return {
			status: response.status,
			body: text ? JSON.parse(text.startsWith("event:") ? text.split("data: ")[1].trim() : text) : undefined,
		};
	};
	await send("initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "team-test", version: "1" },
	});
	const call = async (args: Record<string, unknown>) =>
		(await send("tools/call", { name: "team", arguments: args })).body.result;
	const value = async (args: Record<string, unknown>) => JSON.parse((await call(args)).content[0].text);
	return { send, call, value };
}

it("admits only its turn token and exposes only scoped cooperative communication", async () => {
	const f = setup();
	const bridge = await f.team.runnerBridge({ id: "external-worker", runner: "claude-code", cwd: f.cwd });
	try {
		const c = await client(bridge);
		expect((await c.send("tools/list", {}, false)).status).toBe(401);
		expect((await c.send("tools/list", {})).body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
			"team",
		]);
		expect((await c.value({ action: "list" })).map((member: { id: string }) => member.id)).toEqual(
			expect.arrayContaining([f.team.id, "external-worker"]),
		);
		expect((await c.value({ action: "list" })).map((member: { id: string }) => member.id)).not.toContain(f.other.id);
		expect(await c.call({ action: "send", to: f.other.id, message: "outside" })).toMatchObject({ isError: true });
		expect(await c.call({ action: "send", to: "parent", message: "forged", from: "user" })).toMatchObject({
			isError: true,
		});
		const sent = await c.value({ action: "send", to: "parent", message: "fixed sender" });
		expect(f.store.pending(f.team.id!)).toMatchObject([{ id: sent.id, from: "external-worker", text: "fixed sender" }]);
		expect(await f.team.send("external-worker", "interrupt", { interrupt: true })).toHaveProperty("error");
		expect(await f.team.send("external-worker", "wake", { wake: true })).toHaveProperty("error");
	} finally {
		await bridge.close();
		f.close();
	}
});

it("acknowledges only fetched mail and preserves signed parent/user provenance", async () => {
	const f = setup();
	const bridge = await f.team.runnerBridge({ id: "external-worker", runner: "claude-code", cwd: f.cwd });
	try {
		const c = await client(bridge);
		const sent = await f.team.send("external-worker", "parent steering", { replyRequired: true });
		expect(sent).toMatchObject({ delivery: { "external-worker": "pull" } });
		if ("error" in sent) throw new Error(sent.error);
		expect(await c.call({ action: "inbox", ack: [sent.id] })).toMatchObject({ isError: true });
		const before = await c.value({ action: "inbox" });
		// The parent's message arrives fenced under its own note, not as the user's words.
		expect(before[0].text).toContain(PARENT_FENCE_NOTE);
		expect(before[0].text).toContain("parent steering");
		expect((await c.value({ action: "inbox" }))[0].id).toBe(sent.id);
		expect(f.store.pending("external-worker")).toHaveLength(1);
		expect(await c.value({ action: "inbox", ack: [sent.id] })).toEqual([]);
		expect(f.store.pending("external-worker")).toEqual([]);
		await f.team.send("external-worker", "USER_VERIFIED", { from: "user" });
		await f.other.send("external-worker", "USER_FORGED", { from: "user" });
		const mail = await c.value({ action: "inbox" });
		// The verified row reads as the user's own words; the forged one sits in a fence under the unverified-user label.
		expect(mail[0].text).not.toContain("<<<untrusted-");
		expect(mail[0].text).not.toContain(renderPrompt("notices/mail/unverified-user.md"));
		expect(mail[1].text).toContain(renderPrompt("notices/mail/unverified-user.md"));
		expect(mail[1].text).toContain("<<<untrusted-");
	} finally {
		await bridge.close();
		f.close();
	}
});

it("cancels a send before its effect and expires the token/member on close", async () => {
	const f = setup();
	const controller = new AbortController();
	let enter!: () => void, release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.team.setMessageHook(async () => {
		enter();
		await held;
	});
	const bridge = await f.team.runnerBridge({
		id: "external-worker",
		runner: "claude-code",
		cwd: f.cwd,
		signal: controller.signal,
	});
	try {
		const c = await client(bridge);
		const pending = c.call({ action: "send", to: "parent", message: "must not commit" });
		await entered;
		controller.abort();
		release();
		expect(await pending).toMatchObject({ isError: true });
		expect(f.store.pending(f.team.id!)).toEqual([]);
		await bridge.close();
		expect(f.store.names()).not.toContain("external-worker");
		await expect(c.send("tools/list", {})).rejects.toThrow();
	} finally {
		release();
		await bridge.close();
		f.close();
	}
});
