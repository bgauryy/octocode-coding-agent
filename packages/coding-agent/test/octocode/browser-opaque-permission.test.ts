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

const commands = [
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
	{ tool: "step", input: { step: { op: "cdp", method: "Storage.getCookies" } } },
	{ tool: "script", input: { args: ["fixture.mjs"] } },
	{ tool: "corpus_query", input: { args: ["--script", "fixture.mjs"] } },
	{ tool: "corpus_query", input: { args: ["--script=fixture.mjs"] } },
	{ tool: "corpus_query", input: { args: ["--scraping-skill-dir", "fixture-skill"] } },
	{ tool: "protocol_corpus", input: { args: ["--scraping-skill-dir=fixture-skill"] } },
	{ tool: "har_ingest", input: { args: ["--scraping-skill-dir", "fixture-skill"] } },
	{ tool: "check", input: { recipe: "webmcp-tools", options: { WEBMCP_ACTION: "invoke", WEBMCP_TOOL: "fixture" } } },
	{
		tool: "check",
		input: { recipe: "webmcp-tools", options: { WEBMCP_ACTION: "future-action", WEBMCP_TOOL: "fixture" } },
	},
] as const;

describe("opaque browser programs", () => {
	it.each(commands)(
		"requires cookie-capable approval for $tool without inspecting program text",
		async ({ tool, input }) => {
			const request = await browserMcpRequest(`mcp__browser__${tool}`, input);
			expect([request?.action, ...(request?.also ?? [])]).toContain("browser.cookies");
			if ("args" in input) expect([request?.action, ...(request?.also ?? [])]).toContain("browser.control");
			expect(browserMcpEscalations(`mcp__browser__${tool}`, input).some((entry) => entry.kind === "cookies")).toBe(
				true,
			);
		},
	);

	it.each(commands)("dismissal prevents the entire $tool invocation in full mode", async ({ tool, input }) => {
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
		let executions = 0;
		const result = await gate(
			{ type: "tool_call", toolCallId: "opaque", toolName: `mcp__browser__${tool}`, input },
			ctx,
		);
		if (!result?.block) executions++;
		expect(result?.block).toBe(true);
		expect(executions).toBe(0);
	});

	it.each(commands.slice(6, 11))("refuses local $tool programs in read-only browser roles", ({ tool, input }) => {
		const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
		expect(readOnlyRoleRefusal({ toolName: `mcp__browser__${tool}`, input }, tmp(), env)).toMatch(/read-only role/);
		expect(
			readOnlyRoleRefusal(
				{ toolName: "mcp__browser__corpus_query", input: { args: ["--regex", "fixture"] } },
				tmp(),
				env,
			),
		).toBeUndefined();
	});

	it("keeps typed DOM operations and protocol discovery out of opaque-program escalation", async () => {
		for (const [tool, input] of [
			[
				"run",
				{
					plan: {
						steps: [
							{ op: "act", action: "click", ref: "e1" },
							{ op: "extract", selector: "h1" },
						],
					},
				},
			],
			["snapshot", {}],
			["protocol", { domain: "Runtime", member: "evaluate" }],
			["schema", { command: "run" }],
			["query", { file: "capture.json", where: "response.status=200" }],
			["corpus_query", { args: ["--regex", "fixture"] }],
			["check", { recipe: "webmcp-tools", options: { WEBMCP_ACTION: "list" } }],
		] as const) {
			expect(await browserMcpRequest(`mcp__browser__${tool}`, input)).toBeUndefined();
		}
	});

	it.each([commands[0], commands[6]])(
		"runs opaque $tool code after an explicit once-only approval",
		async ({ tool, input }) => {
			const cwd = tmp();
			const permission = new Permission({ api: fakeHost().api, env: { [PERMISSION_ENV]: "full" }, isSubagent: false });
			const ctx = fakeCtx({ cwd, hasUI: true });
			let approvals = 0;
			ctx.ui.select = async (_title, choices) => {
				approvals++;
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
			expect(approvals).toBe(1);
			expect(result).toBeUndefined();
		},
	);
});
