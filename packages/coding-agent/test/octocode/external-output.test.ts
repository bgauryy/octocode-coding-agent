import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OctocodeApi } from "../../src/octocode/api/bridge.ts";
import { ApiCallError, ApiClient } from "../../src/octocode/api/client.ts";
import { ExternalAgents } from "../../src/octocode/external/manager.ts";
import { parseExternalCommand, registerExternal } from "../../src/octocode/external/register.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const token = `sk-ant-${"a".repeat(40)}`;
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => vi.stubEnv("OCTOCODE_HOME", tmp()));
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
	vi.restoreAllMocks();
});
async function apiClient(externalCall: () => Promise<unknown>) {
	const fake = fakeHost();
	const api = new OctocodeApi(
		fake.api,
		{ list: () => [], tell: () => undefined, deliverable: (text) => text },
		() => "test",
		{ OCTOCODE_HOME: tmp() },
		{ externalCall },
	);
	cleanup.push(() => api.stop());
	await api.start(fakeCtx({ cwd: tmp() }), { socket: true });
	return new ApiClient(api.instance!);
}

// The tool is declared only when something is discoverable; these tests exercise it, not the machine's PATH.
beforeEach(() => {
	vi.spyOn(ExternalAgents.prototype, "discoverable").mockReturnValue(true);
});

describe("external evidence boundaries", () => {
	it("redacts structured tool details as well as the rendered evidence", async () => {
		const fake = fakeHost();
		vi.spyOn(ExternalAgents.prototype, "call").mockResolvedValue({
			reply: { text: token, updates: [{ text: "complete evidence" }] },
		});
		registerExternal(fake.api, new Subcommands(), {
			authorize: async () => undefined,
			beforeSend: async () => undefined,
			afterReceive: async () => undefined,
			permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
			sender: () => "test",
		});
		const result = await fake.tools
			.get("externalAgent")!
			.execute("tool", { action: "list" }, undefined, undefined, fakeCtx({ cwd: tmp() }));
		expect(JSON.stringify(result)).not.toContain(token);
		expect(result.details).toEqual({ reply: { text: "[redacted]", updates: [{ text: "complete evidence" }] } });
		expect(result.isError).toBe(false);
	});

	it("marks failed tool calls as errors while retaining uncertain execution and redacted partial evidence", async () => {
		const fake = fakeHost();
		vi.spyOn(ExternalAgents.prototype, "call").mockRejectedValue(
			Object.assign(new Error(`failed ${token}`), {
				execution: "uncertain",
				partial: { text: "work may have completed", credential: token },
				stderr: token,
			}),
		);
		registerExternal(fake.api, new Subcommands(), {
			authorize: async () => undefined,
			beforeSend: async () => undefined,
			afterReceive: async () => undefined,
			permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
			sender: () => "test",
		});
		const result = await fake.tools
			.get("externalAgent")!
			.execute("tool", { action: "prompt", id: "peer", text: "task" }, undefined, undefined, fakeCtx({ cwd: tmp() }));
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			execution: "uncertain",
			partial: { text: "work may have completed" },
			stderr: "[redacted]",
		});
		expect(JSON.stringify(result)).not.toContain(token);
	});

	it("keeps complete large API results readable beyond the transport frame", async () => {
		const evidence = { reply: { text: "body\n".repeat(300_000) + token, updates: [{ last: "final evidence" }] } };
		const client = await apiClient(async () => evidence);
		const result = await client.call<{ fullOutput: { path: string; bytes: number; format: string } }>("external.call", {
			action: "list",
		});
		const whole = fs.readFileSync(result.fullOutput.path, "utf8");
		expect(Buffer.byteLength(whole)).toBe(result.fullOutput.bytes);
		expect(result.fullOutput.format).toBe("json");
		expect(whole).not.toContain(token);
		expect(JSON.parse(whole)).toEqual({
			reply: { text: `${"body\n".repeat(300_000)}[redacted]`, updates: [{ last: "final evidence" }] },
		});
		expect(fs.statSync(result.fullOutput.path).mode & 0o777).toBe(0o600);
	});

	it("retains execution state and full redacted partial evidence on oversized errors", async () => {
		const client = await apiClient(async () => {
			throw Object.assign(new Error(`failure ${token}`), {
				execution: "uncertain",
				partial: { text: "partial ".repeat(150_000) },
				stderr: token,
			});
		});
		let failure: unknown;
		try {
			await client.call("external.call", { action: "prompt", id: "test", text: "task" });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ApiCallError);
		const error = failure as ApiCallError;
		expect(error.message).not.toContain(token);
		const data = error.data as { execution: string; fullOutput: { path: string } };
		expect(data.execution).toBe("uncertain");
		const whole = JSON.parse(fs.readFileSync(data.fullOutput.path, "utf8"));
		expect(whole.partial.text).toBe("partial ".repeat(150_000));
		expect(whole.stderr).toBe("[redacted]");
	});
});

describe("external agent command syntax", () => {
	it("combines local controls and external discovery under one registration", async () => {
		const fake = fakeHost();
		const commands = new Subcommands();
		const local = vi.fn(async () => {});
		commands.add("agents", { description: "Local agents", handler: local });
		const external = vi.spyOn(ExternalAgents.prototype, "call").mockResolvedValue({ agents: [] });
		registerExternal(fake.api, commands, {
			authorize: async () => undefined,
			beforeSend: async () => undefined,
			afterReceive: async () => undefined,
			permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
			sender: () => "test",
		});
		commands.register(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		await fake.commands.get("agents")!.handler("", ctx);
		// Nothing external to list: the local list stands alone, with no second notice.
		expect(local).toHaveBeenCalledWith("", ctx);
		expect(external).toHaveBeenCalledWith({ action: "list" }, ctx);
		expect(ctx.ui.notes).toEqual([]);
		await fake.commands.get("agents")!.handler("kill local-1", ctx);
		expect(local).toHaveBeenLastCalledWith("kill local-1", ctx);
		expect(external).toHaveBeenCalledTimes(1);
		await fake.commands.get("agents")!.handler("external cancel remote-1", ctx);
		expect(external).toHaveBeenLastCalledWith({ action: "cancel", id: "remote-1" }, ctx);
		expect([...fake.commands.keys()]).toEqual(["agents"]);
	});

	it("bare /agents shows the local list and, when something is connected, readable external rows in the same notice", async () => {
		const fake = fakeHost();
		const commands = new Subcommands();
		commands.add("agents", {
			description: "Local agents",
			handler: async (_args, ctx) => {
				ctx.ui.notify("sly-crab · working · 15s", "info");
			},
		});
		const external = vi.spyOn(ExternalAgents.prototype, "call").mockResolvedValue({
			connections: [
				{ id: "claude-1", transport: "acp", vendor: "claude", cwd: "/work/app", sessionId: "s", busy: true },
			],
			instances: [{ id: "inst-9", pid: 4242, cwd: "/work/other", protocol: 1 }],
		});
		registerExternal(fake.api, commands, {
			authorize: async () => undefined,
			beforeSend: async () => undefined,
			afterReceive: async () => undefined,
			permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
			sender: () => "test",
		});
		commands.register(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		await fake.commands.get("agents")!.handler("", ctx);
		expect(external).toHaveBeenCalledOnce();
		expect(ctx.ui.notes).toHaveLength(1);
		const text = ctx.ui.notes[0].message;
		expect(text).toContain("sly-crab · working · 15s");
		expect(text).toContain("● claude-1 · acp claude · busy · /work/app");
		expect(text).toContain("○ octocode inst-9 · pid 4242 · /work/other");
		expect(text).not.toMatch(/untrusted|[{}"]/);
	});

	it("/agents external renders results as sentences, never JSON or the untrusted fence", async () => {
		const fake = fakeHost();
		const commands = new Subcommands();
		const external = vi.spyOn(ExternalAgents.prototype, "call");
		registerExternal(fake.api, commands, {
			authorize: async () => undefined,
			beforeSend: async () => undefined,
			afterReceive: async () => undefined,
			permission: () => async () => ({ outcome: { outcome: "cancelled" } }),
			sender: () => "test",
		});
		commands.register(fake.api);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		const agents = fake.commands.get("agents")!;
		external.mockResolvedValueOnce({ connections: [], instances: [] });
		await agents.handler("external list", ctx);
		external.mockResolvedValueOnce({ id: "x", reply: { text: `all done ${token}`, stopReason: "end_turn" } });
		await agents.handler("external prompt x hello", ctx);
		external.mockResolvedValueOnce({ disconnected: "x" });
		await agents.handler("external disconnect x", ctx);
		external.mockRejectedValueOnce(Object.assign(new Error("boom"), { execution: "uncertain" }));
		await agents.handler("external cancel x", ctx);
		expect(ctx.ui.notes.map((note) => note.message)).toEqual([
			"No external agents connected or available.",
			"x replied (end_turn):\nall done [redacted]",
			"Disconnected x.",
			"External agent error: boom\nExecution: uncertain",
		]);
		expect(ctx.ui.notes.map((note) => note.type)).toEqual(["info", "info", "info", "error"]);
	});

	it("supports discovery, connection and control without JSON", () => {
		expect(parseExternalCommand("")).toEqual({ action: "list" });
		expect(parseExternalCommand("connect octocode instance-1")).toEqual({
			action: "connect",
			transport: "octocode",
			instanceId: "instance-1",
		});
		expect(parseExternalCommand("connect acp claude claude --acp")).toEqual({
			action: "connect",
			transport: "acp",
			vendor: "claude",
			command: "claude",
			args: ["--acp"],
		});
		expect(parseExternalCommand('connect acp claude "/Applications/Agent App/agent" "argument with spaces"')).toEqual({
			action: "connect",
			transport: "acp",
			vendor: "claude",
			command: "/Applications/Agent App/agent",
			args: ["argument with spaces"],
		});
		expect(parseExternalCommand("prompt prompt review  this file")).toEqual({
			action: "prompt",
			id: "prompt",
			text: "review  this file",
		});
		expect(parseExternalCommand("cancel agent-1")).toEqual({ action: "cancel", id: "agent-1" });
		expect(parseExternalCommand("disconnect agent-1")).toEqual({ action: "disconnect", id: "agent-1" });
		expect(() => parseExternalCommand("cancel")).toThrow("Usage: /agents external");
	});
});
