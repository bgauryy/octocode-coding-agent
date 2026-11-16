import { createEventBus } from "@octocodeai/octocode-agent-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ToolCallEvent, ToolInfo } from "../../src/core/features/index.ts";
import { READ_ONLY_ENV, SUBAGENT_ENV, PERMISSION_ENV } from "@octocodeai/octocode-common/env";
import { toTool } from "../../../mcp/src/client/client/results.ts";
import { registerMcpHookCaller } from "../../../mcp/src/hook-caller.ts";
import { publishToolRoles, resolveToolRoles, currentToolRoles } from "../../../mcp/src/roles.ts";
import type { McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";
import type { McpServerStatus } from "../../../mcp/src/status.ts";
import { createMcpToolDefinition } from "../../../mcp/src/tool-definition.ts";
import { createMcpToolName } from "../../../mcp/src/tool-names.ts";
import { createOctocodeCommand } from "../../src/octocode/cli/command.ts";
import { boundMcpHookCaller } from "../../src/octocode/hooks/mcp-gate.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { classify } from "../../src/octocode/permission/gate/classify.ts";
import { setMcpReadOnlyTools } from "../../src/octocode/permission/mcp-reads.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { planReadOnly } from "../../src/octocode/permission/shell/plan-reads.ts";
import { planningRefusal } from "../../src/octocode/plan/gate.ts";
import { registerToolGates, type ToolGatesOptions } from "../../src/octocode/tool-gates.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** One test per finding of the permission review, each failing before its fix. */

const readOnlyEnv = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
const research = { reader: ["localFetch"], search: ["localSearch", "lspSearch"], readOnly: ["ghStructure"] };
const octocode = (tool: string) => createMcpToolName("octocode", tool);
const call = (toolName: string, input: Record<string, unknown>) =>
	({ type: "tool_call", toolCallId: "t1", toolName, input }) as ToolCallEvent;

beforeAll(shellParserReady);
beforeEach(() => {
	publishToolRoles(resolveToolRoles([{ name: "octocode", config: { roles: research } as McpServerConfig }]));
	setMcpReadOnlyTools(() => currentToolRoles().readOnly);
});
afterEach(() => {
	publishToolRoles(resolveToolRoles([]));
});

describe("F1: a read-only role and MCP tools", () => {
	const refusal = (toolName: string, input: Record<string, unknown> = {}) =>
		readOnlyRoleRefusal({ toolName, input }, tmp(), readOnlyEnv);

	it("refuses an MCP tool its server does not declare read-only", () => {
		expect(refusal("mcp__github__create_pull_request", { title: "x" })).toMatch(/read-only role/);
		expect(refusal("mcp__linear__delete_issue")).toMatch(/read-only role/);
	});

	it("lets a declared read run by its role alone: the server's arguments are not read", () => {
		expect(refusal(octocode("localSearch"), { queries: [{ path: "." }] })).toBeUndefined();
		expect(refusal(octocode("ghStructure"), { anything: { nested: true } })).toBeUndefined();
		expect(refusal("mcp__other__lookup", { queries: [{ path: "." }] })).toMatch(/read-only role/);
	});

	it("refuses every MCP tool until the host installs the role set", () => {
		setMcpReadOnlyTools(() => new Set());
		expect(refusal(octocode("localSearch"))).toMatch(/read-only role/);
	});

	it("leaves a session that is not a read-only child alone", () => {
		expect(readOnlyRoleRefusal({ toolName: "mcp__github__create_pull_request", input: {} }, tmp(), {})).toBeUndefined();
	});
});

describe("F2: plan mode decides an MCP call by its server's roles", () => {
	const mcp = (name: string) =>
		({ name, sourceInfo: { owner: "builtin", path: "builtin:mcp" } }) as unknown as ToolInfo;
	const connected = [{ name: "octocode", enabled: true, state: "connected" }] as McpServerStatus[];
	const plan = (tool: string, input: Record<string, unknown>) =>
		planningRefusal({ toolName: octocode(tool), input }, mcp(octocode(tool)), connected);

	it("runs a declared read of a connected server whatever its arguments", () => {
		expect(plan("lspSearch", { queries: [{ path: "a.rs", symbolName: "f", line: 1 }] })).toBeUndefined();
		expect(plan("ghStructure", { anything: { nested: true } })).toBeUndefined();
	});

	it("blocks a tool no role declares, and a declared read of a server that is not connected", () => {
		expect(plan("graphBuild", {})).toMatch(/Plan mode blocks/);
		const tool = octocode("localSearch");
		expect(planningRefusal({ toolName: tool, input: {} }, mcp(tool), [])).toMatch(/Plan mode blocks/);
	});
});

describe("F3: an MCP tool its server marks destructive", () => {
	function gate(mode: "workspace" | "full") {
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
		const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
		permission.start(ctx);
		const run = permissionGate({
			permission,
			provenance: { check: () => undefined },
			annotations: (name) => (name === "mcp__db__drop" ? { destructiveHint: true } : { destructiveHint: false }),
		});
		return (toolName: string) => run(call(toolName, { table: "users" }), ctx);
	}

	it("asks in workspace mode, so a headless session refuses it, while other MCP tools run", async () => {
		const run = gate("workspace");
		expect(await run("mcp__db__drop")).toMatchObject({ block: true });
		expect(await run("mcp__db__list")).toBeUndefined();
	});

	it("runs in full mode", async () => {
		expect(await gate("full")("mcp__db__drop")).toBeUndefined();
	});

	it("reaches the tool definition from the server's annotations, and only the destructive hint", () => {
		const tool = toTool({
			name: "drop",
			inputSchema: { type: "object" },
			annotations: { destructiveHint: true, readOnlyHint: true, title: "x" },
		});
		expect(tool.annotations).toEqual({ destructiveHint: true });
		expect(toTool({ name: "a", inputSchema: {}, annotations: { destructiveHint: false } }).annotations).toBeUndefined();
		const definition = createMcpToolDefinition({
			server: "db",
			tool,
			name: "mcp__db__drop",
			exposure: "direct",
			namespace: { name: "db" },
			timeoutMs: 1000,
			getClient: async () => {
				throw new Error("unused");
			},
		} as unknown as Parameters<typeof createMcpToolDefinition>[0]);
		expect(definition.annotations).toEqual({ destructiveHint: true });
	});
});

describe("F10: MCP reads never ask", () => {
	function gate(mode: "manual" | "workspace") {
		const fake = fakeHost();
		const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
		const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: mode }, isSubagent: false });
		permission.start(ctx);
		const run = permissionGate({
			permission,
			provenance: { check: () => undefined },
			annotations: (name) => (name === octocode("astSearch") ? { destructiveHint: true } : undefined),
		});
		return (toolName: string, input: Record<string, unknown> = {}) => run(call(toolName, input), ctx);
	}

	it("runs a declared read unasked in manual mode, and classes it mcp.read", async () => {
		const run = gate("manual");
		expect(await run(octocode("localSearch"), { queries: [{ path: "." }] })).toBeUndefined();
		expect(classify(call(octocode("localSearch"), {}), { cwd: tmp() })?.action).toBe("mcp.read");
	});

	it("still asks in manual mode for a write, and for a destructive hint on a declared read", async () => {
		const run = gate("manual");
		expect(await run("mcp__github__create_pull_request")).toMatchObject({ block: true });
		publishToolRoles(
			resolveToolRoles([
				{ name: "octocode", config: { roles: { ...research, readOnly: ["astSearch"] } } as McpServerConfig },
			]),
		);
		expect(await gate("workspace")(octocode("astSearch"))).toMatchObject({ block: true });
	});
});

describe("F5, F7, F8: the shell classifiers agree that `octocode` is a program they do not model", () => {
	const search = `octocode localSearch '{"queries":[{"path":"src","matchString":["x"]}]}'`;
	const child = (command: string) => readOnlyRoleRefusal({ toolName: "bash", input: { command } }, tmp(), readOnlyEnv);

	it("refuses it to a read-only role and blocks it in plan mode, by its words, through xargs or after a PATH change", () => {
		for (const command of [
			search,
			`${search} | head -20`,
			"echo q | xargs octocode x",
			`PATH=/tmp/x:$PATH ${search}`,
		]) {
			expect(child(command), command).toMatch(/read-only role/);
			expect(planReadOnly(command), command).toBe(false);
		}
	});
});

describe("F6: a hook's MCP call and the cloud metadata invariant", () => {
	it("refuses opening a metadata address in full mode", async () => {
		const fake = fakeHost();
		fake.api.events = createEventBus();
		const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
		const permission = new Permission({ api: fake.api, env: { [PERMISSION_ENV]: "full" }, isSubagent: false });
		permission.start(ctx);
		registerToolGates(fake.api, {
			permission,
			provenance: { check: () => undefined },
			collab: { reservationGate: async () => undefined },
			hooks: { preToolUse: async () => undefined },
			sourcePolicy: { refresh: async () => undefined },
			activity: { checking: () => undefined },
			localReads: new Map(),
		} as unknown as ToolGatesOptions);
		const reached: string[] = [];
		registerMcpHookCaller(fake.api.events, async (request) => {
			await request.authorize({ toolName: createMcpToolName(request.server, request.tool), input: request.input });
			reached.push(request.tool);
			return { content: [] };
		});
		const run = boundMcpHookCaller(fake.api.events, ctx)!;
		const goto = {
			plan: { steps: [{ op: "goto", url: "http://169.254.169.254/latest" }] },
			connection: { port: 9222 },
		};
		await expect(
			run({
				server: "browser",
				tool: "browser_action",
				input: goto,
				signal: new AbortController().signal,
				waitForConnection: false,
			}),
		).rejects.toThrow(/metadata/);
		expect(reached).toEqual([]);
	});
});

describe("F9: /octocode commands the user types", () => {
	it("are recorded in the audit log before they run", async () => {
		const record = vi.fn();
		const ui = {
			notify: vi.fn(),
			custom: vi.fn(async () => undefined),
			setStatus: vi.fn(),
			onTerminalInput: () => () => undefined,
		};
		const ctx = { hasUI: true, cwd: process.cwd(), ui } as unknown as ExtensionCommandContext;
		await createOctocodeCommand(record).handler("--version", ctx);
		expect(record).toHaveBeenCalledWith("/octocode --version", process.cwd());
	});
});
