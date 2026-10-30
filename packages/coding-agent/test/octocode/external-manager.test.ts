import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/extensions/index.ts";
import { AcpError } from "../../../acp/src/client/client.ts";
import {
	ExternalAgents,
	MAX_EXTERNAL_CONNECTIONS,
	type ExternalFactories,
	type ExternalPolicy,
} from "../../src/octocode/external/manager.ts";
import type {
	ExternalBackend,
	ExternalInfo,
	ExternalParams,
	ExternalReply,
} from "../../src/octocode/external/protocol.ts";
import { externalFailure, registerExternal } from "../../src/octocode/external/register.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { withDialog } from "../../src/octocode/shared/locks.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const managers: ExternalAgents[] = [];
const roots: string[] = [];
function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
function backend(cwd: string, sessionId = "external-session") {
	return {
		cwd,
		sessionId,
		prompt: vi.fn<ExternalBackend["prompt"]>(async (text) => ({ text: `remote:${text}`, stopReason: "end_turn" })),
		cancel: vi.fn<ExternalBackend["cancel"]>(async () => undefined),
		close: vi.fn<ExternalBackend["close"]>(async () => undefined),
	} satisfies ExternalBackend;
}
function setup() {
	const root = mkdtempSync(join(tmpdir(), "external-manager-"));
	roots.push(root);
	const cwd = realpathSync(root);
	const ctx = fakeCtx({ cwd });
	const owned = backend(cwd);
	const authorize = vi.fn<ExternalPolicy["authorize"]>(async () => undefined);
	const beforeSend = vi.fn<ExternalPolicy["beforeSend"]>(async () => undefined);
	const afterReceive = vi.fn<ExternalPolicy["afterReceive"]>(async () => undefined);
	const permission = vi.fn<ExternalPolicy["permission"]>(() => async () => ({ outcome: { outcome: "cancelled" } }));
	const acp = vi.fn(async () => owned);
	const octocode = vi.fn(async () => owned);
	const policy = { authorize, beforeSend, afterReceive, permission, sender: () => "local-session" };
	const manager = new ExternalAgents(policy, { acp, octocode } as unknown as ExternalFactories);
	managers.push(manager);
	const input = {
		action: "connect",
		id: "one",
		transport: "acp",
		vendor: "fixture",
		command: "/literal/executable",
		args: ["one argument"],
		cwd,
	} satisfies ExternalParams;
	const connect = () => manager.call(input, ctx);
	const prompt = (text = "task") => manager.call({ action: "prompt", id: "one", text }, ctx);
	const list = async () =>
		((await manager.call({ action: "list" }, ctx)) as { connections: ExternalInfo[] }).connections;
	return {
		ctx,
		owned,
		manager,
		policy,
		authorize,
		beforeSend,
		afterReceive,
		permission,
		acp,
		octocode,
		input,
		connect,
		prompt,
		list,
		cwd,
	};
}
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.reset()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external manager policy and lifecycle", () => {
	it("reserves the connection cap before concurrent authorization and releases disconnected slots", async () => {
		const state = setup();
		const gate = deferred<void>();
		state.authorize.mockImplementation(() => gate.promise);
		const pending = Array.from({ length: MAX_EXTERNAL_CONNECTIONS }, (_, i) =>
			state.manager.call({ ...state.input, id: `connection-${i}` }, state.ctx),
		);
		await expect(state.manager.call({ ...state.input, id: "overflow" }, state.ctx)).rejects.toThrow(
			`limit (${MAX_EXTERNAL_CONNECTIONS})`,
		);
		expect(state.authorize).toHaveBeenCalledTimes(MAX_EXTERNAL_CONNECTIONS);
		expect(state.acp).not.toHaveBeenCalled();
		gate.resolve();
		await Promise.all(pending);
		await state.manager.call({ action: "disconnect", id: "connection-0" }, state.ctx);
		await state.manager.call({ ...state.input, id: "replacement" }, state.ctx);
		expect(await state.list()).toHaveLength(MAX_EXTERNAL_CONNECTIONS);
	});

	it("keeps a live ACP peer busy after a prompt timeout until cancellation", async () => {
		const state = setup();
		const manager = new ExternalAgents(state.policy);
		managers.push(manager);
		const journal = join(state.cwd, "timeout-events.jsonl");
		await manager.call(
			{
				...state.input,
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/external-acp-agent.mjs", import.meta.url)), "wait", journal],
			},
			state.ctx,
		);
		await expect(
			manager.call({ action: "prompt", id: "one", text: "work", timeoutMs: 1000 }, state.ctx),
		).rejects.toMatchObject({ execution: "uncertain" });
		expect(manager.running).toBe(1);
		expect(await manager.call({ action: "list" }, state.ctx)).toMatchObject({
			connections: [{ id: "one", busy: true }],
		});
		await expect(manager.call({ action: "prompt", id: "one", text: "no overlap" }, state.ctx)).rejects.toMatchObject({
			execution: "not-sent",
		});
		expect(state.beforeSend).toHaveBeenCalledOnce();
		expect(await manager.call({ action: "list" }, state.ctx)).toMatchObject({ connections: [{ id: "one" }] });
		await manager.call({ action: "cancel", id: "one" }, state.ctx);
		expect(manager.running).toBe(0);
		await expect(manager.call({ action: "prompt", id: "one", text: "closed" }, state.ctx)).rejects.toThrow(
			"Unknown external connection",
		);
		expect(await manager.call({ action: "list" }, state.ctx)).toMatchObject({ connections: [] });
	});

	it("clears ACP busy state when a timed-out remote prompt settles and accepts a later prompt", async () => {
		const state = setup();
		const manager = new ExternalAgents(state.policy);
		managers.push(manager);
		const journal = join(state.cwd, "settlement-events.jsonl");
		await manager.call(
			{
				...state.input,
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/external-acp-agent.mjs", import.meta.url)), "gated", journal],
			},
			state.ctx,
		);
		await expect(
			manager.call({ action: "prompt", id: "one", text: "old output", timeoutMs: 1000 }, state.ctx),
		).rejects.toMatchObject({ execution: "uncertain" });
		expect(manager.running).toBe(1);
		expect(await manager.call({ action: "list" }, state.ctx)).toMatchObject({
			connections: [{ id: "one", busy: true }],
		});
		writeFileSync(`${journal}.release`, "settle");
		await vi.waitFor(async () => {
			expect(manager.running).toBe(0);
			expect(await manager.call({ action: "list" }, state.ctx)).toMatchObject({
				connections: [{ id: "one", busy: false }],
			});
		});
		await expect(
			manager.call({ action: "prompt", id: "one", text: "new output", timeoutMs: 5000 }, state.ctx),
		).resolves.toMatchObject({ reply: { text: "first\nnew output", stopReason: "end_turn" }, busy: false });
		expect(manager.running).toBe(0);
	});

	it("releases prompt ownership if the sender session becomes unavailable before dispatch", async () => {
		const state = setup();
		await state.connect();
		state.policy.sender = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("session getter revoked");
			})
			.mockReturnValue("local-session");
		await expect(state.prompt()).rejects.toThrow("session getter revoked");
		expect(state.manager.running).toBe(0);
		expect(state.owned.prompt).not.toHaveBeenCalled();
		await expect(state.prompt("recovered")).resolves.toMatchObject({ reply: { text: "remote:recovered" } });
		expect(state.owned.prompt).toHaveBeenCalledOnce();
	});

	it("requires valid actions and an existing connection, and never starts a refused connection", async () => {
		const state = setup();
		await expect(state.manager.call({ action: "prompt", text: "missing id" }, state.ctx)).rejects.toThrow(
			"requires id",
		);
		await expect(state.prompt()).rejects.toThrow("Unknown external connection");
		state.authorize.mockRejectedValueOnce(new Error("launch refused"));
		await expect(state.connect()).rejects.toThrow("launch refused");
		expect(state.acp).not.toHaveBeenCalled();
		expect(await state.list()).toEqual([]);
	});

	it("passes canonical connection input through authorization before constructing an adapter", async () => {
		const state = setup();
		expect(await state.connect()).toMatchObject({ cwd: state.cwd, sessionId: "external-session", busy: false });
		expect(state.authorize).toHaveBeenCalledWith(state.input, state.ctx, expect.any(AbortSignal));
		expect(state.permission).toHaveBeenCalledWith(state.ctx);
		expect(state.acp).toHaveBeenCalledOnce();
		expect(state.octocode).not.toHaveBeenCalled();
	});

	it("hook block prevents authorization and sending, then releases the connection for another prompt", async () => {
		const state = setup();
		await state.connect();
		state.authorize.mockClear();
		state.beforeSend.mockRejectedValueOnce(new Error("hook.block"));
		await expect(state.prompt()).rejects.toThrow("hook.block");
		expect(state.authorize).not.toHaveBeenCalled();
		expect(state.owned.prompt).not.toHaveBeenCalled();
		expect(state.manager.running).toBe(0);
		expect(await state.prompt("allowed")).toMatchObject({ reply: { text: "remote:allowed" } });
	});

	it("hook ask sends nothing while waiting and sends nothing when its decision refuses", async () => {
		const state = setup();
		await state.connect();
		state.authorize.mockClear();
		const decision = deferred<boolean>();
		state.beforeSend.mockImplementationOnce(async () => {
			if (!(await decision.promise)) throw new Error("hook.ask refused");
		});
		const result = state.prompt().catch((error: unknown) => error);
		await vi.waitFor(() => expect(state.beforeSend).toHaveBeenCalledOnce());
		expect(state.owned.prompt).not.toHaveBeenCalled();
		expect(state.authorize).not.toHaveBeenCalled();
		decision.resolve(false);
		expect(((await result) as Error).message).toBe("hook.ask refused");
		expect(state.owned.prompt).not.toHaveBeenCalled();
		expect(state.manager.running).toBe(0);
	});

	it("refused prompt authorization sends nothing after a passing hook", async () => {
		const state = setup();
		await state.connect();
		state.authorize.mockRejectedValueOnce(new Error("prompt refused"));
		await expect(state.prompt()).rejects.toThrow("prompt refused");
		expect(state.beforeSend).toHaveBeenCalledOnce();
		expect(state.owned.prompt).not.toHaveBeenCalled();
		expect(state.afterReceive).not.toHaveBeenCalled();
		expect(state.manager.running).toBe(0);
	});

	it("rejects a concurrent prompt while the first is still in its pre-send hook", async () => {
		const state = setup();
		await state.connect();
		const gate = deferred<void>();
		state.beforeSend.mockImplementationOnce(() => gate.promise);
		const first = state.prompt("first");
		await vi.waitFor(() => expect(state.beforeSend).toHaveBeenCalledOnce());
		await expect(state.prompt("second")).rejects.toThrow("in flight");
		// The refused second prompt reached nothing, and the failure says so (the model may retry after the first ends).
		expect(externalFailure(await state.prompt("third").catch((error: unknown) => error))).toMatchObject({
			execution: "not-sent",
		});
		expect(state.owned.prompt).not.toHaveBeenCalled();
		gate.resolve();
		await first;
		expect(state.owned.prompt).toHaveBeenCalledOnce();
		expect(state.owned.prompt.mock.calls[0]?.[0]).toBe("first");
	});

	it("reserves an id before connection authorization and prevents competing adapters", async () => {
		const state = setup();
		const gate = deferred<void>();
		state.authorize.mockImplementationOnce(() => gate.promise);
		const first = state.connect();
		await vi.waitFor(() => expect(state.authorize).toHaveBeenCalledOnce());
		await expect(state.connect()).rejects.toThrow("already exists");
		expect(state.acp).not.toHaveBeenCalled();
		gate.resolve();
		await first;
		expect(state.acp).toHaveBeenCalledOnce();
		expect(await state.list()).toHaveLength(1);
	});

	it("reset during pre-send aborts the pending send before dispatch", async () => {
		const state = setup();
		await state.connect();
		const gate = deferred<void>();
		state.beforeSend.mockImplementationOnce(() => gate.promise);
		const result = state.prompt().catch((error: unknown) => error);
		await vi.waitFor(() => expect(state.beforeSend).toHaveBeenCalledOnce());
		const signal = state.beforeSend.mock.calls[0]?.[2];
		await state.manager.reset();
		expect(signal?.aborted).toBe(true);
		gate.resolve();
		expect(await result).toBeInstanceOf(Error);
		expect(state.owned.prompt).not.toHaveBeenCalled();
		expect(state.owned.close).toHaveBeenCalledOnce();
		expect(await state.list()).toEqual([]);
	});

	it("reset during connection authorization prevents startup and cannot delete a replacement using the same id", async () => {
		const state = setup();
		const gate = deferred<void>();
		state.authorize.mockImplementationOnce(() => gate.promise);
		const first = state.connect().catch((error: unknown) => error);
		await vi.waitFor(() => expect(state.authorize).toHaveBeenCalledOnce());
		await state.manager.reset();
		await state.connect();
		gate.resolve();
		expect(await first).toBeInstanceOf(Error);
		expect(state.acp).toHaveBeenCalledOnce();
		expect(await state.list()).toMatchObject([{ id: "one", sessionId: "external-session" }]);
		expect(state.owned.close).not.toHaveBeenCalled();
	});

	it("reset during factory startup closes a late backend without closing or removing a replacement", async () => {
		const state = setup();
		const late = backend(state.cwd, "late-session");
		const gate = deferred<typeof late>();
		state.acp.mockImplementationOnce(() => gate.promise);
		const first = state.connect().catch((error: unknown) => error);
		await vi.waitFor(() => expect(state.acp).toHaveBeenCalledOnce());
		await state.manager.reset();
		await state.connect();
		gate.resolve(late);
		expect(await first).toBeInstanceOf(Error);
		expect(late.close).toHaveBeenCalledOnce();
		expect(state.owned.close).not.toHaveBeenCalled();
		expect(await state.list()).toMatchObject([{ id: "one", sessionId: "external-session" }]);
	});

	it("cancel during pre-send prevents dispatch and preserves an idle usable connection", async () => {
		const state = setup();
		await state.connect();
		const gate = deferred<void>();
		state.beforeSend.mockImplementationOnce(() => gate.promise);
		const result = state.prompt().catch((error: unknown) => error);
		await vi.waitFor(() => expect(state.beforeSend).toHaveBeenCalledOnce());
		await state.manager.call({ action: "cancel", id: "one" }, state.ctx);
		gate.resolve();
		expect(await result).toBeInstanceOf(Error);
		expect(state.owned.prompt).not.toHaveBeenCalled();
		expect(await state.prompt("later")).toMatchObject({ reply: { text: "remote:later" } });
		expect(await state.list()).toHaveLength(1);
	});

	it("rejects already-aborted callers before hooks, authorization or factory startup", async () => {
		const state = setup();
		await expect(
			state.manager.call(state.input, state.ctx, AbortSignal.abort(new Error("caller stopped"))),
		).rejects.toThrow("caller stopped");
		expect(state.authorize).not.toHaveBeenCalled();
		expect(state.acp).not.toHaveBeenCalled();
		expect(state.beforeSend).not.toHaveBeenCalled();
	});

	it("disconnect aborts pending work and allows a fresh explicit connection with the same id", async () => {
		const state = setup();
		await state.connect();
		const gate = deferred<void>();
		state.beforeSend.mockImplementationOnce(() => gate.promise);
		const result = state.prompt().catch((error: unknown) => error);
		await vi.waitFor(() => expect(state.beforeSend).toHaveBeenCalledOnce());
		await state.manager.call({ action: "disconnect", id: "one" }, state.ctx);
		await state.connect();
		gate.resolve();
		expect(await result).toBeInstanceOf(Error);
		expect(state.owned.prompt).not.toHaveBeenCalled();
		expect(state.acp).toHaveBeenCalledTimes(2);
		expect(await state.list()).toHaveLength(1);
	});

	it("retains full reply evidence and matches send/receive envelopes without clipping", async () => {
		const state = setup();
		await state.connect();
		const evidence = "every evidence row\n".repeat(30_000);
		const reply: ExternalReply = { text: evidence, stopReason: "end_turn", updates: [{ full: evidence }] };
		state.owned.prompt.mockResolvedValueOnce(reply);
		const result = (await state.prompt("request")) as { reply: ExternalReply };
		expect(result.reply).toEqual(reply);
		const outbound = state.beforeSend.mock.calls[0]?.[0];
		const inbound = state.afterReceive.mock.calls[0]?.[0];
		expect(outbound).toMatchObject({
			channel: "external",
			direction: "outbound",
			from: "local-session",
			to: "one",
			text: "request",
		});
		expect(inbound).toMatchObject({
			channel: "external",
			direction: "inbound",
			from: "one",
			to: "local-session",
			text: evidence,
			replyTo: outbound.id,
		});
		expect(state.owned.prompt.mock.calls[0]?.[1].key).toBe(outbound.id);
	});

	it("authorizes the actual backend workspace and host when the caller context has another cwd", async () => {
		const state = setup();
		await state.connect();
		state.authorize.mockClear();
		const otherCtx = { ...state.ctx, cwd: "/different-caller-workspace" } as ExtensionContext;
		await state.manager.call({ action: "prompt", id: "one", text: "request" }, otherCtx);
		expect(state.authorize.mock.calls[0]?.[0]).toMatchObject({
			cwd: state.cwd,
			vendor: "fixture",
			transport: "acp",
			sessionId: "external-session",
		});
	});

	it("rejects prompt metadata that tries to spoof the existing connection before policy or dispatch", async () => {
		const state = setup();
		await state.connect();
		state.authorize.mockClear();
		await expect(
			state.manager.call(
				{ action: "prompt", id: "one", text: "request", cwd: "/spoofed", vendor: "spoofed", transport: "octocode" },
				state.ctx,
			),
		).rejects.toThrow("does not accept");
		expect(state.authorize).not.toHaveBeenCalled();
		expect(state.beforeSend).not.toHaveBeenCalled();
		expect(state.owned.prompt).not.toHaveBeenCalled();
	});

	it("exposes ACP failure evidence intact and removes the poisoned owned connection", async () => {
		const state = setup();
		await state.connect();
		const evidence = "completed evidence\n".repeat(30_000);
		const partial: ExternalReply = { text: evidence, updates: [{ full: evidence }] };
		const failure = new AcpError("timed out", partial, "full diagnostic", new Error("timeout"));
		state.owned.prompt.mockRejectedValueOnce(failure);
		const error = await state.prompt().catch((error: unknown) => error);
		expect(error).toBe(failure);
		expect(externalFailure(error)).toMatchObject({ execution: "uncertain", partial, stderr: "full diagnostic" });
		expect(state.afterReceive).not.toHaveBeenCalled();
		expect(await state.list()).toEqual([]);
		await state.connect();
		expect(state.acp).toHaveBeenCalledTimes(2);
	});

	it("preserves completed evidence when the receiving hook fails", async () => {
		const state = setup();
		await state.connect();
		const reply = { text: "completed answer", stopReason: "end_turn", updates: [{ complete: true }] };
		state.owned.prompt.mockResolvedValueOnce(reply);
		state.afterReceive.mockRejectedValueOnce(new Error("receive hook failed"));
		const result = (await state.prompt()) as { reply: ExternalReply; receiveHookError?: string };
		expect(result.reply).toEqual(reply);
		expect(result.receiveHookError).toContain("receive hook failed");
		expect(state.owned.prompt).toHaveBeenCalledOnce();
		expect(await state.list()).toHaveLength(1);
	});

	it("runs ACP permission dialogs while the registered external command waits for its reply", async () => {
		const state = setup();
		const fake = fakeHost();
		const commands = new Subcommands();
		const decision = vi.fn<ReturnType<ExternalPolicy["permission"]>>(async (_request, signal) =>
			withDialog(async () => {
				signal.throwIfAborted();
				return { outcome: { outcome: "selected", optionId: "deny" } };
			}, signal),
		);
		state.permission.mockReturnValue(decision);
		const manager = registerExternal(fake.api, commands, state.policy);
		managers.push(manager);
		commands.register(fake.api);
		const journal = join(state.cwd, "acp-events.jsonl");
		const fixture = fileURLToPath(new URL("./fixtures/external-acp-agent.mjs", import.meta.url));
		const tool = fake.tools.get("externalAgent")!;
		const connected = await tool.execute(
			"connect-tool",
			{
				action: "connect",
				id: "permission-agent",
				transport: "acp",
				vendor: "fixture",
				cwd: state.cwd,
				command: process.execPath,
				args: [fixture, "permission", journal],
				timeoutMs: 5000,
			},
			new AbortController().signal,
			undefined,
			state.ctx,
		);
		expect(connected.details).toMatchObject({ id: "permission-agent", sessionId: "fixture-session" });
		await fake.commands
			.get("agents")!
			.handler(
				`external ${JSON.stringify({ action: "prompt", id: "permission-agent", text: "edit", timeoutMs: 5000 })}`,
				state.ctx,
			);
		expect(decision).toHaveBeenCalledOnce();
		expect(state.ctx.ui.notes.at(-1)?.message).toContain("end_turn");
		const events = readFileSync(journal, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { event: string; response?: unknown });
		expect(events.find((entry) => entry.event === "permission")?.response).toEqual({
			outcome: { outcome: "selected", optionId: "deny" },
		});
	}, 10_000);
});
