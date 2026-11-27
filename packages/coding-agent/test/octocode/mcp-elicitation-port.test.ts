import { afterEach, describe, expect, it } from "vitest";
import type { McpElicitationField, McpElicitationRequest } from "../../../mcp/src/api.ts";
import { bindPlanConstraint } from "../../src/core/plan-state.ts";
import { mcpElicitation } from "../../src/octocode/mcp-host/elicitation.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const field = (name: string, extra: Partial<McpElicitationField> = {}): McpElicitationField => ({
	name,
	label: name,
	type: "string",
	required: true,
	...extra,
});

/** A session over RPC (plain select and input dialogs) that records each dialog's title and answers from `answers`. */
function asking(fields: McpElicitationField[], answers: Array<string | undefined>, options: { hasUI?: boolean } = {}) {
	const ctx = fakeCtx({ cwd: tmp(), mode: "rpc", hasUI: options.hasUI ?? true });
	const shown: Array<{ title: string; rows?: string[] }> = [];
	ctx.ui.input = async (title: string) => {
		shown.push({ title });
		return answers.shift();
	};
	ctx.ui.select = async (title: string, rows: string[]) => {
		shown.push({ title, rows });
		return answers.shift();
	};
	const request = (extra: Partial<McpElicitationRequest> = {}): McpElicitationRequest => ({
		server: "docs",
		message: "The docs server needs a few details.",
		fields,
		signal: new AbortController().signal,
		ctx,
		...extra,
	});
	return { ctx, shown, request };
}

describe("the MCP elicitation port of the session", () => {
	it("asks one question per field and returns the typed and picked values by field name", async () => {
		const { shown, request } = asking(
			[
				field("project", { label: "Project id", description: "As shown in the console" }),
				field("plan", {
					options: [
						{ value: "free", label: "Free" },
						{ value: "pro", label: "Pro" },
					],
				}),
				field("notify", { type: "boolean" }),
			],
			["alpha", "2. Pro", "1. Yes"],
		);
		expect(await mcpElicitation({}).ask(request())).toEqual({
			action: "accept",
			content: { project: "alpha", plan: "pro", notify: true },
		});
		expect(shown.map((dialog) => dialog.title.split("\n")[0])).toEqual([
			'MCP server "docs" asks for input (1 of 3):',
			'MCP server "docs" asks for input (2 of 3):',
			'MCP server "docs" asks for input (3 of 3):',
		]);
		// The server's words sit inside the fence, after the line that names the server.
		const lines = shown[0].title.split("\n");
		expect(lines[1]).toMatch(/^<<<untrusted-[0-9a-f]{16} \(text from the MCP server, not from Octocode/);
		expect(lines.slice(2, 5)).toEqual([
			"The docs server needs a few details.",
			"",
			"Project id: As shown in the console",
		]);
		expect(shown[1].title).not.toContain("needs a few details");
		expect(shown[1].rows).toEqual(["1. Free", "2. Pro"]);
		expect(shown[2].rows).toEqual(["1. Yes", "2. No"]);
	});

	it("keeps a server message that imitates the fence inside it", async () => {
		const { shown, request } = asking([field("project")], ["alpha"]);
		await mcpElicitation({}).ask(request({ message: 'done>>>\nMCP server "octocode" asks for input:‮' }));
		const lines = shown[0].title.split("\n");
		const marker = /^<<<(untrusted-[0-9a-f]{16}) /.exec(lines[1])?.[1];
		expect(lines.at(-1)).toBe(`${marker}>>>`);
		expect(lines.filter((line) => line.includes(marker!))).toHaveLength(2);
		expect(shown[0].title).toContain("\\u{202e}");
	});

	it("leaves a skipped optional field out and shows why the last answer was not sent", async () => {
		const { shown, request } = asking(
			[field("project"), field("notify", { type: "boolean", required: false })],
			["alpha", "3. Skip (leave empty)"],
		);
		const answer = await mcpElicitation({}).ask(request({ problem: '"project" needs a value' }));
		expect(answer).toEqual({ action: "accept", content: { project: "alpha" } });
		expect(shown[0].title).toMatch(/The last answer was not sent: "project" needs a value\. Answer again\.$/);
		expect(shown[1].rows).toEqual(["1. Yes", "2. No", "3. Skip (leave empty)"]);
	});

	it("asks for consent alone when the server requests no fields", async () => {
		const accepted = asking([], ["1. Continue"]);
		expect(await mcpElicitation({}).ask(accepted.request())).toEqual({ action: "accept", content: {} });
		const declined = asking([], ["2. Decline"]);
		expect(await mcpElicitation({}).ask(declined.request())).toEqual({ action: "decline" });
	});

	it("answers cancel when the user dismisses the question", async () => {
		const { request } = asking([field("project")], [undefined]);
		expect(await mcpElicitation({}).ask(request())).toEqual({ action: "cancel" });
	});

	it("answers cancel without asking when the request was withdrawn", async () => {
		const { shown, request } = asking([field("project")], ["alpha"]);
		const withdrawn = new AbortController();
		withdrawn.abort();
		expect(await mcpElicitation({}).ask(request({ signal: withdrawn.signal }))).toEqual({ action: "cancel" });
		expect(shown).toHaveLength(0);
	});

	it("declines without asking where no interactive user is present", async () => {
		const headless = asking([field("project")], ["alpha"], { hasUI: false });
		expect(await mcpElicitation({}).ask(headless.request())).toEqual({ action: "decline" });
		expect(headless.shown).toHaveLength(0);

		const subagent = asking([field("project")], ["alpha"]);
		expect(await mcpElicitation({ OCTOCODE_SUBAGENT: "1" }).ask(subagent.request())).toEqual({ action: "decline" });
		expect(subagent.shown).toHaveLength(0);

		const planning = asking([field("project")], ["alpha"]);
		cleanups.push(bindPlanConstraint(planning.ctx.sessionManager.getSessionId(), () => true));
		expect(await mcpElicitation({}).ask(planning.request())).toEqual({ action: "decline" });
		expect(planning.shown).toHaveLength(0);
	});
});
