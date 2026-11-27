import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { externalPermission } from "../../src/octocode/external/permission-dialog.ts";
import { OctocodeApi } from "../../src/octocode/api/bridge.ts";
import { ApiClient } from "../../src/octocode/api/client.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { ALLOW_ONCE } from "../../src/octocode/permission/ask/text.ts";
import { admitExternalMessage } from "../../src/octocode/permission/external-message.ts";
import type { PermissionMode } from "../../src/octocode/permission/mode.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** `external.call` and `agents.tell` through the real socket, the real permission layer and the real admission check. */

let home: string;
const running: OctocodeApi[] = [];
beforeEach(() => {
	home = tmp("octocode-api-ceiling-");
	vi.stubEnv(ENV_AGENT_DIR, home);
	vi.stubEnv("OCTOCODE_HOME", home);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(running.splice(0).map((api) => api.stop()));
});

function setting(value: string): void {
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "settings.json"), JSON.stringify({ sessionApiTurnPermission: value }));
}

async function boot(options: { hasUI: boolean; selects?: string[] }) {
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { OCTOCODE_PERMISSION: "full" }, isSubagent: false });
	const base = fakeCtx({ cwd: tmp(), hasUI: options.hasUI, ui: { selects: options.selects ?? [] } });
	const ctx = Object.assign(base, {
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { ...base.sessionManager, getSessionId: () => "s1" },
	});
	permission.start(ctx);
	/** What an external call sees while it runs, and what its agent's own permission request gets (`externalPermission`). */
	const seen: Array<{ mode: PermissionMode; cap: PermissionMode | undefined }> = [];
	const externalCall = vi.fn(async () => {
		seen.push({ mode: permission.mode, cap: permission.turnCap.active });
		const request = {
			toolCall: { toolCallId: "t1", title: "write" },
			options: [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "reject", name: "Reject", kind: "reject_once" },
			],
		};
		const answer = await externalPermission(permission)(ctx)(request as never, new AbortController().signal);
		return { answer: answer.outcome.outcome };
	});
	const told: Array<[string, string]> = [];
	const api = new OctocodeApi(
		fake.api,
		{
			list: () => [{ id: "main-1" }],
			tell: (to, text) => {
				told.push([to, text]);
				return { sent: [to] };
			},
			deliverable: (text) => text,
		},
		() => "1.0.0",
		{ OCTOCODE_HOME: home },
		{
			admit: (claim, askCtx, signal, onAsk) =>
				admitExternalMessage(permission, askCtx, claim, {
					self: claim.self,
					planning: false,
					...(claim.ceiling ? { ceiling: claim.ceiling } : {}),
					...(onAsk ? { onAsk } : {}),
					...(signal ? { signal } : {}),
				}),
			capTurn: (ceiling) => permission.turnCap.set(ceiling),
			externalCall,
		},
	);
	running.push(api);
	await api.start(ctx, { socket: true });
	return { api, ctx, permission, client: new ApiClient(api.instance!), seen, externalCall, told, fake };
}

const CONNECT = { action: "connect", command: "agent", args: [] };

describe("with sessionApiTurnPermission set to workspace, a full session holds every API entry point to workspace", () => {
	beforeEach(() => setting("workspace"));

	// The call is admitted as an external message first (asked under the ceiling, as message.send and agents.tell are).
	it("refuses external.call when nobody can be asked, and starts nothing", async () => {
		const { client, externalCall } = await boot({ hasUI: false });
		await expect(client.call("external.call", CONNECT)).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(externalCall).not.toHaveBeenCalled();
	});

	it("runs external.call under the ceiling: its agent's permission request is not answered for it", async () => {
		// The one queued answer admits the call. The agent's own request then asks the user too (workspace mode asks), finds
		// no queued answer, and the fake dialog closes unanswered: that, not a session without a UI, is the "cancelled".
		const { client, permission, seen } = await boot({ hasUI: true, selects: [ALLOW_ONCE] });
		await expect(client.call("external.call", CONNECT)).resolves.toEqual({ answer: "cancelled" });
		expect(seen).toEqual([{ mode: "workspace", cap: "workspace" }]);
		// The call is over: the session's own mode is back.
		expect(permission.turnCap.active).toBeUndefined();
		expect(permission.mode).toBe("full");
	});

	it("puts the external agent's request to the user, still under the ceiling while it runs", async () => {
		const { client, permission, seen } = await boot({ hasUI: true, selects: [ALLOW_ONCE, "Allow"] });
		await expect(client.call("external.call", CONNECT)).resolves.toEqual({ answer: "selected" });
		expect(seen).toEqual([{ mode: "workspace", cap: "workspace" }]);
		expect(permission.turnCap.active).toBeUndefined();
	});

	it("releases the ceiling when the external call throws", async () => {
		const { client, permission, externalCall } = await boot({ hasUI: true, selects: [ALLOW_ONCE] });
		externalCall.mockRejectedValueOnce(new Error("agent crashed"));
		await expect(client.call("external.call", CONNECT)).rejects.toMatchObject({ message: "agent crashed" });
		expect(permission.turnCap.active).toBeUndefined();
	});

	it("keeps the ceiling of a turn message.send started when an external call ends meanwhile", async () => {
		const { client, permission } = await boot({ hasUI: true, selects: [ALLOW_ONCE, ALLOW_ONCE, "Allow"] });
		await client.call("message.send", { text: "start" });
		await vi.waitFor(() => expect(permission.turnCap.active).toBe("workspace"));
		await client.call("external.call", CONNECT);
		expect(permission.turnCap.active).toBe("workspace");
	});

	it("refuses agents.tell when nobody can be asked, and sends nothing", async () => {
		const { client, told } = await boot({ hasUI: false });
		await expect(client.call("agents.tell", { to: "main-1", text: "do it" })).rejects.toMatchObject({
			data: { execution: "not-sent" },
		});
		expect(told).toEqual([]);
	});

	it("asks the user about agents.tell, then sends once they allow it", async () => {
		const { client, told, ctx } = await boot({ hasUI: true, selects: [ALLOW_ONCE] });
		await client.call("agents.tell", { to: "main-1", text: "do it" });
		expect(told).toEqual([["main-1", expect.stringContaining("do it")]]);
		expect((ctx as unknown as { ui: { selects: string[] } }).ui.selects).toEqual([]);
	});
});

describe.each([
	["unset", undefined],
	["session", "session"],
])("with sessionApiTurnPermission %s, a full session gives API calls full permission", (_label, value) => {
	beforeEach(() => {
		if (value) setting(value);
	});

	it("runs external.call in full, its agent's request allowed unasked, with nothing capped", async () => {
		const { client, permission, seen } = await boot({ hasUI: false });
		await expect(client.call("external.call", CONNECT)).resolves.toEqual({ answer: "selected" });
		expect(seen).toEqual([{ mode: "full", cap: undefined }]);
		expect(permission.turnCap.active).toBeUndefined();
	});

	it("takes agents.tell unasked", async () => {
		const { client, told } = await boot({ hasUI: false });
		await client.call("agents.tell", { to: "main-1", text: "do it" });
		expect(told).toEqual([["main-1", expect.stringContaining("do it")]]);
	});
});
