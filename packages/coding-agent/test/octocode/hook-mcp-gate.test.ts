import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import type { ToolAnnotations, ToolCallEvent } from "../../src/core/features/index.ts";
import { registerMcpHookCaller } from "../../../mcp/src/hook-caller.ts";
import { boundMcpHookCaller } from "../../src/octocode/hooks/mcp-gate.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { registerToolGates, type ToolGatesOptions } from "../../src/octocode/tool-gates.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const hints: Record<string, ToolAnnotations> = {
	mcp__db__drop: { destructiveHint: true },
	mcp__db__list: { readOnlyHint: true },
};

/** The MCP owner as `mcp/events.ts` drives it: the tool is authorized before the server is reached. */
function setup(mode: "manual" | "workspace" | "full", options: { hit?: string } = {}) {
	const fake = fakeHost();
	fake.api.events = createEventBus();
	const ctx = fakeCtx({ cwd: tmp(), hasUI: true, ui: { selects: [] } });
	const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
	permission.start(ctx);
	const preToolUse: string[] = [];
	const gateCalls: ToolCallEvent[] = [];
	registerToolGates(fake.api, {
		permission,
		provenance: {
			check: (event: ToolCallEvent) => {
				gateCalls.push(event);
				return options.hit ? { why: options.hit } : undefined;
			},
		},
		annotations: (name: string) => hints[name],
		collab: { reservationGate: async () => undefined },
		hooks: {
			preToolUse: async (event: { toolName: string }) => {
				preToolUse.push(event.toolName);
				return undefined;
			},
		},
		sourcePolicy: { refresh: async () => undefined },
		activity: { checking: () => undefined },
		localReads: new Map(),
	} as unknown as ToolGatesOptions);
	const reached: string[] = [];
	registerMcpHookCaller(fake.api.events, async (request) => {
		await request.authorize({ toolName: `mcp__${request.server}__${request.tool}`, input: request.input });
		reached.push(request.tool);
		return { content: [{ type: "text", text: "ok" }] };
	});
	const call = boundMcpHookCaller(fake.api.events, ctx)!;
	const run = (tool: string) =>
		call({
			server: "db",
			tool,
			input: { table: "users" },
			signal: new AbortController().signal,
			waitForConnection: true,
		});
	return { run, reached, preToolUse, gateCalls, ctx, fake };
}

describe("hook-initiated MCP calls and the permission gate", () => {
	it("records hook origin separately from unique invocation IDs", async () => {
		const { run, gateCalls } = setup("full");
		await run("list");
		await run("list");
		expect(gateCalls.map((call) => call.origin)).toEqual(["hook", "hook"]);
		expect(gateCalls[0].toolCallId).not.toBe(gateCalls[1].toolCallId);
	});
	it("asks in manual mode for a destructive tool and refuses it when the user says no", async () => {
		const { run, reached, ctx } = setup("manual");
		ctx.ui.select = async () => "Deny";
		await expect(run("drop")).rejects.toThrow(/mcp__db__drop refused/);
		expect(reached).toEqual([]);
	});

	it("requires approval even when an MCP tool supplies a read-only annotation", async () => {
		const { run, reached, ctx } = setup("manual");
		ctx.ui.select = vi.fn(async () => "Allow once");
		await run("list");
		expect(ctx.ui.select).toHaveBeenCalledOnce();
		expect(reached).toEqual(["list"]);
	});

	it("follows the mode like a model call: full asks nothing", async () => {
		const { run, reached } = setup("full");
		await run("drop");
		expect(reached).toEqual(["drop"]);
	});

	it("asks for a provenance hit on a read-only tool", async () => {
		const { run, reached, ctx } = setup("manual", { hit: "the input came from a fetched page" });
		ctx.ui.select = async () => "Deny";
		await expect(run("list")).rejects.toThrow(/refused/);
		expect(reached).toEqual([]);
	});

	it("does not run PreToolUse hooks for the hook's own call (recursion guard)", async () => {
		const { run, preToolUse } = setup("full");
		await run("drop");
		expect(preToolUse).toEqual([]);
	});

	it("exempts a PermissionRequest hook, which answers an ask and could not wait on its own", async () => {
		const { fake, reached, ctx } = setup("manual");
		const call = boundMcpHookCaller(fake.api.events, ctx, "PermissionRequest")!;
		await call({
			server: "db",
			tool: "drop",
			input: {},
			signal: new AbortController().signal,
			waitForConnection: false,
		});
		expect(reached).toEqual(["drop"]);
	});

	it("refuses a hook call made while another is being decided (a Notification hook for the ask)", async () => {
		const { run, fake, reached, ctx } = setup("manual");
		const nested = boundMcpHookCaller(fake.api.events, ctx, "Notification")!;
		let inner: unknown;
		ctx.ui.select = async () => {
			// The ask announces itself; a Notification hook's MCP call arrives while it waits.
			inner = await nested({
				server: "db",
				tool: "drop",
				input: {},
				signal: new AbortController().signal,
				waitForConnection: false,
			}).catch((error: Error) => error.message);
			return "Allow once";
		};
		await run("drop");
		expect(inner).toMatch(/another is being decided/);
		expect(reached).toEqual(["drop"]);
	});

	it("refuses a hook call when no gate is registered", async () => {
		const events = createEventBus();
		let reached = false;
		registerMcpHookCaller(events, async (request) => {
			await request.authorize({ toolName: "mcp__db__list", input: {} });
			reached = true;
			return { content: [] };
		});
		const call = boundMcpHookCaller(events, fakeCtx({ cwd: tmp() }))!;
		await expect(
			call({ server: "db", tool: "list", input: {}, signal: new AbortController().signal, waitForConnection: false }),
		).rejects.toThrow(/no permission gate/);
		expect(reached).toBe(false);
	});
});
