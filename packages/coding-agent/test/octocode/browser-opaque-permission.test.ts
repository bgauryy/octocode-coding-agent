import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSION_ENV, READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { browserMcpEscalations } from "../../src/octocode/permission/browser-mcp-escalations.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { permissionGate } from "../../src/octocode/permission/gate.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { browserMcpRequest } from "../../src/octocode/web/browser-mcp.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** Raw protocol, whatever its method: the cookie-capable approval covers it without inspecting the call. */
const cdpCommands = [
	{ tool: "cdp", input: { method: "Runtime.evaluate", params: { expression: "document.title" } } },
	{
		tool: "cdp",
		input: { method: "Runtime.callFunctionOn", params: { functionDeclaration: "function(){return this}" } },
	},
	{ tool: "cdp", input: { method: "FutureDomain.newMethod", params: {} } },
	{
		tool: "run",
		input: {
			plan: {
				steps: [
					{ op: "act", action: "click", ref: "e1" },
					{ op: "cdp", method: "DOM.getDocument" },
				],
			},
		},
	},
	{ tool: "run", input: { plan: { steps: [{ op: "cdp", method: "Storage.getCookies" }] } } },
] as const;

/** Page code and programs the package runs: `browser.control`, which a read-only role is refused. */
const programs = [
	{ tool: "run", input: { plan: { steps: [{ op: "evaluate", expression: "document.title" }] } } },
	{ tool: "flow", input: { action: "run", name: "handle-dialog", params: { trigger: "alert(1)" } } },
	{ tool: "open", input: { port: 9222, attach: true, acknowledge: true } },
	{ tool: "open", input: { launch: { chromePath: "/tmp/fixture-program" } } },
] as const;

const approvals = (request: Awaited<ReturnType<typeof browserMcpRequest>>) => [
	request?.action,
	...(request?.also ?? []),
];

describe("opaque browser programs", () => {
	it.each(cdpCommands)(
		"requires cookie-capable approval for $tool without inspecting its text",
		async ({ tool, input }) => {
			const request = await browserMcpRequest(`mcp__browser__${tool}`, input);
			expect(approvals(request)).toContain("browser.cookies");
			expect(browserMcpEscalations(`mcp__browser__${tool}`, input).some((entry) => entry.kind === "cookies")).toBe(
				true,
			);
		},
	);

	it.each(programs)("requires browser.control approval for $tool code and programs", async ({ tool, input }) => {
		expect(approvals(await browserMcpRequest(`mcp__browser__${tool}`, input))).toContain("browser.control");
	});

	it.each(cdpCommands)("dismissal prevents the entire $tool invocation in full mode", async ({ tool, input }) => {
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".git"));
		const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: "full" }, isSubagent: false });
		const ctx = fakeCtx({ cwd, hasUI: true });
		permission.start(ctx);
		const gate = permissionGate({
			permission,
			env: {},
			provenance: { check: () => undefined },
			annotations: () => ({ readOnlyHint: true }),
			network: (toolName, args, folder) => browserMcpRequest(toolName, args, undefined, folder),
		});
		const result = await gate(
			{ type: "tool_call", toolCallId: "opaque", toolName: `mcp__browser__${tool}`, input },
			ctx,
		);
		expect(result?.block).toBe(true);
	});

	it.each(programs)("refuses $tool programs in read-only browser roles", ({ tool, input }) => {
		const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
		expect(readOnlyRoleRefusal({ toolName: `mcp__browser__${tool}`, input }, tmp(), env)).toMatch(/read-only role/);
		expect(
			readOnlyRoleRefusal({ toolName: "mcp__browser__query", input: { file: "capture.json" } }, tmp(), env),
		).toBeUndefined();
	});

	it("keeps typed DOM operations, saved-file reads and discovery out of escalation", async () => {
		for (const [tool, input] of [
			[
				"run",
				{
					plan: {
						steps: [
							{ op: "act", action: "click", ref: "e1" },
							{ op: "extract", selector: "h1" },
							{ op: "snapshot" },
							{ op: "screenshot" },
						],
					},
				},
			],
			["protocol", { member: "Runtime.evaluate" }],
			["schema", { command: "run" }],
			["query", { file: "capture.json", where: [{ path: "/response/status", op: "eq", value: 200 }] }],
			["artifact", { file: "capture.json" }],
			["skill", { topic: "operating" }],
			["flow", { action: "run", name: "extract-links", params: { url: "https://example.com/" } }],
			["flow", { action: "list" }],
			["targets", {}],
			["cleanup", { port: 9222 }],
			["group", { action: "list" }],
			["open", { url: "https://example.com/", headless: true }],
		] as const) {
			expect(browserMcpEscalations(`mcp__browser__${tool}`, input), tool).toEqual([]);
		}
	});

	it.each([cdpCommands[0], cdpCommands[3]])(
		"runs opaque $tool code after an explicit once-only approval",
		async ({ tool, input }) => {
			const cwd = tmp();
			const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: "full" }, isSubagent: false });
			const ctx = fakeCtx({ cwd, hasUI: true });
			let asked = 0;
			ctx.ui.select = async (_title, choices) => {
				asked++;
				return choices[0];
			};
			permission.start(ctx);
			const gate = permissionGate({
				permission,
				env: {},
				provenance: { check: () => undefined },
				network: (tool, input, folder) => browserMcpRequest(tool, input, undefined, folder),
			});
			const result = await gate(
				{ type: "tool_call", toolCallId: "approved", toolName: `mcp__browser__${tool}`, input },
				ctx,
			);
			expect(asked).toBe(1);
			expect(result).toBeUndefined();
		},
	);
});
