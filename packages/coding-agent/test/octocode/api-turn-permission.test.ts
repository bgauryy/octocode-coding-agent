import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { ApiOperations } from "../../src/octocode/api/bridge/contracts.ts";
import { sendMessage } from "../../src/octocode/api/bridge/send.ts";
import { OctocodeApi } from "../../src/octocode/api/bridge.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { SendReceipts } from "../../src/octocode/api/receipts.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { ALLOW_ONCE } from "../../src/octocode/permission/ask/text.ts";
import { admitExternalMessage } from "../../src/octocode/permission/external-message.ts";
import type { PermissionRequest } from "../../src/octocode/permission/request.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** A call `workspace` asks about and `full` runs: what an API-started turn must not do unasked. */
const outsideWrite = (): PermissionRequest => ({
	action: "file.outside",
	title: "Write this file?",
	what: ["/etc/example"],
});

let home: string;
beforeEach(() => {
	home = tmp("octocode-api-turn-");
	vi.stubEnv(ENV_AGENT_DIR, home);
	vi.stubEnv("OCTOCODE_HOME", home);
});
afterEach(() => vi.unstubAllEnvs());

function setting(value: string): void {
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "settings.json"), JSON.stringify({ sessionApiTurnPermission: value }));
}

/** A session in `full`, as `octocode` starts by default, reached through the real send path and the real admission check. */
function setup(options: { hasUI: boolean; idle?: boolean; mode?: string; selects?: string[] }) {
	const fake = fakeHost();
	const permission = new Permission({
		api: fake.api,
		env: { OCTOCODE_PERMISSION: options.mode ?? "full" },
		isSubagent: false,
	});
	const state = { idle: options.idle ?? true };
	const base = fakeCtx({ cwd: tmp(), hasUI: options.hasUI, ui: { selects: options.selects ?? [] } });
	const ctx = Object.assign(base, {
		isIdle: () => state.idle,
		sessionManager: { ...base.sessionManager, getSessionId: () => "s1" },
	});
	permission.start(ctx);
	const capTurn = vi.fn((ceiling) => permission.turnCap.set(ceiling));
	const operations: ApiOperations = {
		admit: (claim, askCtx, signal, onAsk) =>
			admitExternalMessage(permission, askCtx, claim, {
				self: claim.self,
				planning: false,
				...(claim.ceiling ? { ceiling: claim.ceiling } : {}),
				...(onAsk ? { onAsk } : {}),
				...(signal ? { signal } : {}),
			}),
		capTurn,
	};
	const receipts = new SendReceipts();
	receipts.follow("s1");
	const send = vi.fn((_message?: unknown, _options?: unknown): unknown => undefined);
	const audits: Array<Record<string, unknown>> = [];
	const host = {
		api: { sendMessage: send },
		agents: { list: () => [], deliverable: (text: string) => text },
		operations,
		receipts,
		log: new EventLog(),
		session: () => ctx,
		guardSession: () => undefined,
		nextId: () => "x1",
		audit: (data: Record<string, unknown>) => audits.push(data),
	} as unknown as Parameters<typeof sendMessage>[0];
	return { host, permission, ctx, state, send, capTurn, audits, operations };
}

const caller = { name: "claude-code-sim", pid: 4242 };

describe("a turn the session API starts on an idle session", () => {
	it("is refused when nobody can be asked, by default, in a session in full", async () => {
		const { host, permission, send, capTurn } = setup({ hasUI: false });
		const refused: Error = await sendMessage(host, { text: "run it", from: "claude-code-sim", caller }).then(
			() => {
				throw new Error("expected a refusal");
			},
			(error: Error) => error,
		);
		expect(refused).toMatchObject({ data: { execution: "not-sent" } });
		expect(refused.message).toContain("held to workspace mode");
		expect(refused.message).toContain("sessionApiTurnPermission");
		expect(send).not.toHaveBeenCalled();
		expect(capTurn).not.toHaveBeenCalled();
		expect(permission.mode).toBe("full");
	});

	it("asks its user, then runs its tools in workspace mode until the session settles", async () => {
		const { host, permission, ctx, send, audits } = setup({ hasUI: true, selects: [ALLOW_ONCE] });
		expect(permission.mode).toBe("full");
		// Its user is asked first, so the sender hears at once that the user decides; the turn starts once they allow it.
		await expect(sendMessage(host, { text: "run it", from: "claude-code-sim", caller })).resolves.toMatchObject({
			queued: "waiting-for-user",
		});
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
		expect(ctx.ui.selects).toEqual([]);

		// The turn's tools: what workspace asks about asks, and with nobody to answer it is refused.
		expect(permission.mode).toBe("workspace");
		const dialog = vi.fn(async () => "deny" as const);
		expect(await permission.check(ctx, outsideWrite(), dialog)).toMatchObject({ allowed: false, via: "user" });
		expect(dialog).toHaveBeenCalledTimes(1);
		const headless = fakeCtx({ cwd: ctx.cwd, hasUI: false });
		expect(await permission.check(headless, outsideWrite())).toMatchObject({ allowed: false, via: "headless" });

		// The caller is recorded as a claim, with what held the turn.
		expect(audits.at(-1)).toMatchObject({
			method: "message.send",
			from: "claude-code-sim",
			caller,
			callerVerified: false,
			turnPermission: "workspace",
		});

		// Settled: the session's own mode is back for the user's next turn.
		permission.turnCap.set(undefined);
		expect(permission.mode).toBe("full");
		expect(await permission.check(headless, outsideWrite())).toMatchObject({ allowed: true, via: "mode" });
	});

	it("does not run when its user denies the message", async () => {
		const { host, send, capTurn } = setup({ hasUI: true, selects: ["Deny"] });
		await expect(sendMessage(host, { text: "run it", wait: true, timeoutMs: 1_000 })).rejects.toMatchObject({
			data: { execution: "not-sent" },
		});
		expect(send).not.toHaveBeenCalled();
		expect(capTurn).not.toHaveBeenCalled();
	});

	it("never loosens a session already stricter than the ceiling", () => {
		const { permission, ctx } = setup({ hasUI: false, mode: "manual" });
		permission.turnCap.set("workspace");
		expect(permission.mode).toBe("manual");
		permission.setMode("workspace", ctx);
		permission.turnCap.set(undefined);
		expect(permission.mode).toBe("workspace");
	});

	it("releases the ceiling when the host refuses the hand-off", async () => {
		const { host, permission, send, capTurn } = setup({ hasUI: true, selects: [ALLOW_ONCE] });
		send.mockImplementation(() => {
			throw new Error("host rejected");
		});
		await expect(sendMessage(host, { text: "run it", wait: true, timeoutMs: 1_000 })).rejects.toMatchObject({
			data: { execution: "uncertain" },
		});
		expect(capTurn).toHaveBeenLastCalledWith(undefined);
		expect(permission.mode).toBe("full");
	});

	it("releases the ceiling when the session settles", async () => {
		const fake = fakeHost();
		const capTurn = vi.fn();
		new OctocodeApi(
			fake.api,
			{ list: () => [], tell: () => ({}), deliverable: (text) => text },
			() => undefined,
			{},
			{
				capTurn,
			},
		).observe();
		await fake.emit("agent_settled", { aborted: false }, fakeCtx({ cwd: tmp() }));
		expect(capTurn).toHaveBeenCalledWith(undefined);
	});
});

describe("with sessionApiTurnPermission set to session", () => {
	it("takes the turn unasked and runs its tools in the session's own mode, as before", async () => {
		setting("session");
		const { host, permission, ctx, send, capTurn } = setup({ hasUI: false });
		await expect(sendMessage(host, { text: "run it", from: "claude-code-sim", caller })).resolves.toEqual({
			id: "x1",
			queued: "turn",
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(capTurn).not.toHaveBeenCalled();
		expect(permission.mode).toBe("full");
		expect(await permission.check(ctx, outsideWrite())).toMatchObject({ allowed: true, via: "mode" });
	});

	it("still holds the turn for any other value", async () => {
		setting("anything");
		const { host, send } = setup({ hasUI: false });
		await expect(sendMessage(host, { text: "run it" })).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(send).not.toHaveBeenCalled();
	});
});

describe("a message to a turn that is already running", () => {
	it("steers it as before: no ask, no ceiling, the session's mode", async () => {
		const { host, permission, ctx, send, capTurn } = setup({ hasUI: false, idle: false });
		await expect(sendMessage(host, { text: "also this", from: "claude-code-sim", caller })).resolves.toEqual({
			id: "x1",
			queued: "steer",
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[1]).toMatchObject({ deliverAs: "steer" });
		expect(capTurn).not.toHaveBeenCalled();
		expect(permission.mode).toBe("full");
		expect(await permission.check(ctx, outsideWrite())).toMatchObject({ allowed: true, via: "mode" });
	});

	it("keeps the ceiling of an API-started turn it steers, and asks about the steer as workspace mode does", async () => {
		const { host, permission, state, send, capTurn, ctx } = setup({ hasUI: true, selects: [ALLOW_ONCE, ALLOW_ONCE] });
		await sendMessage(host, { text: "start" });
		await vi.waitFor(() => expect(capTurn).toHaveBeenCalledTimes(1));
		state.idle = false;
		await sendMessage(host, { text: "steer" });
		await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
		expect(send.mock.calls[1]?.[1]).toMatchObject({ deliverAs: "steer" });
		expect(ctx.ui.selects).toEqual([]);
		expect(capTurn).toHaveBeenCalledTimes(1);
		expect(permission.mode).toBe("workspace");
	});
});
