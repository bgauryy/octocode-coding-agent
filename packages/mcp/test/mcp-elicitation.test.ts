import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mcpElicitation } from "../../coding-agent/src/octocode/mcp-host/elicitation.ts";
import { hostElicitation, installMcpHost } from "../src/host.ts";
import type { McpElicitationAnswer, McpElicitationRequest } from "../src/host/elicitation.ts";
import { checkAnswer, readElicitation } from "../src/runtime/elicitation.ts";
import { validateMcpServerConfig } from "../src/servers.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

const elicit = join(import.meta.dirname, "../../coding-agent/test/octocode/fixtures/elicit-mcp.mjs");
const installed = hostElicitation();
const hosts: ReturnType<typeof mcpHost>[] = [];

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((h) => h.close()));
	installMcpHost({ elicitation: installed });
});

/** A session whose one server asks for input; `config` adds to its entry. */
async function session(config: Record<string, unknown> = {}, options: { hasUI?: boolean } = {}) {
	const h = mcpHost({
		...options,
		updateConfig: () => {},
		loadConfig: (_ctx, defaults) => ({
			servers: defaults.map((entry) => ({ ...entry, config: { ...entry.config, ...config } })),
			errors: [],
		}),
		prepareLaunch: (entry) => ({ ...entry, config: { ...entry.config, command: process.execPath, args: [elicit] } }),
	});
	hosts.push(h);
	await h.start();
	await h.prompt();
	return h;
}

/** What the server's tool reported: the client's capabilities, or its answer to the server's request. */
async function reported(h: ReturnType<typeof mcpHost>, tool: "ask" | "capabilities", params?: unknown) {
	const result = await h.call(`mcp__octocode__${tool}`, params === undefined ? {} : { params });
	const part = (result.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === "text");
	return JSON.parse(part?.text ?? "null") as Record<string, unknown>;
}

/** A host port that records what it is asked and answers from `answers`, in order. */
function fakePort(...answers: McpElicitationAnswer[]) {
	const asked: McpElicitationRequest[] = [];
	installMcpHost({
		elicitation: {
			ask: async (request) => {
				asked.push(request);
				return answers.shift() ?? { action: "cancel" };
			},
		},
	});
	return asked;
}

const form = (properties: Record<string, unknown>, required?: string[]) => ({
	message: "Fill this in",
	requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
});

describe("MCP elicitation over a connection", () => {
	it("declares the form capability, asks the host port and sends the checked answer to the server", async () => {
		const asked = fakePort({ action: "accept", content: { project: "alpha", count: "3", extra: "dropped" } });
		const h = await session();
		expect(await reported(h, "capabilities")).toMatchObject({ elicitation: { form: {} } });

		const answer = await reported(
			h,
			"ask",
			form({ project: { type: "string", title: "Project‮ id" }, count: { type: "integer" } }, ["project"]),
		);
		expect(answer).toEqual({ action: "accept", content: { project: "alpha", count: 3 } });
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ server: "octocode", message: "Fill this in" });
		expect(asked[0].ctx).toBe(h.ctx);
		expect(asked[0].fields).toMatchObject([
			{ name: "project", label: "Project\\u{202e} id", type: "string", required: true },
			{ name: "count", label: "count", type: "integer", required: false },
		]);
	});

	it("declines a field that looks like a secret without asking", async () => {
		const asked = fakePort({ action: "accept", content: { apiKey: "sk-1" } });
		const h = await session();
		for (const properties of [
			{ apiKey: { type: "string" } },
			{ value: { type: "string", title: "Your password" } },
			{ value: { type: "string", format: "password" } },
			{ project: { type: "string" }, github_token: { type: "string" } },
		])
			expect(await reported(h, "ask", form(properties))).toEqual({ action: "decline" });
		expect(asked).toHaveLength(0);
	});

	it("declines URL mode and fields that are not flat primitives without asking", async () => {
		const asked = fakePort({ action: "accept", content: {} });
		const h = await session();
		const url = { mode: "url", message: "Sign in", elicitationId: "e1", url: "https://example.com/login" };
		expect(await reported(h, "ask", url)).toEqual({ action: "decline" });
		const list = { type: "array", items: { type: "string", enum: ["a", "b"] } };
		expect(await reported(h, "ask", form({ tags: list }))).toEqual({ action: "decline" });
		expect(await reported(h, "ask", form({ nested: { type: "object" } }))).toEqual({ action: "decline" });
		expect(asked).toHaveLength(0);
	});

	it("passes the user's refusal and dismissal on as decline and cancel", async () => {
		fakePort({ action: "decline" }, { action: "cancel" });
		const h = await session();
		expect(await reported(h, "ask")).toEqual({ action: "decline" });
		expect(await reported(h, "ask")).toEqual({ action: "cancel" });
	});

	it("asks again with the reason when the answer does not fit the request, and cancels after three tries", async () => {
		const asked = fakePort(
			{ action: "accept", content: { size: "huge" } },
			{ action: "accept", content: { size: "large" } },
		);
		const h = await session();
		const size = form({ size: { type: "string", enum: ["small", "large"] } }, ["size"]);
		expect(await reported(h, "ask", size)).toEqual({ action: "accept", content: { size: "large" } });
		expect(asked.map((request) => request.problem)).toEqual([undefined, '"size" must be one of the listed options']);

		const again = fakePort(...[1, 2, 3, 4].map(() => ({ action: "accept" as const, content: {} })));
		expect(await reported(h, "ask", size)).toEqual({ action: "cancel" });
		expect(again).toHaveLength(3);
	});

	it('does not declare the capability for a server with "elicitation": false, whose request is refused as unknown', async () => {
		const asked = fakePort({ action: "accept", content: { project: "alpha" } });
		const h = await session({ elicitation: false });
		expect(await reported(h, "capabilities")).not.toHaveProperty("elicitation");
		expect(await reported(h, "ask")).toMatchObject({ error: { code: -32601 } });
		expect(asked).toHaveLength(0);
	});

	it("does not declare the capability when the host installed no port", async () => {
		installMcpHost({ elicitation: undefined });
		const h = await session();
		expect(await reported(h, "capabilities")).not.toHaveProperty("elicitation");
	});
});

describe("MCP elicitation answered by the session's user", () => {
	it("asks the user of an interactive session, naming the server, and sends the typed answer", async () => {
		installMcpHost({ elicitation: mcpElicitation({}) });
		const h = await session();
		const titles: string[] = [];
		Object.assign(h.ctx, { mode: "rpc" });
		h.ctx.ui.input = async (title: string) => {
			titles.push(title);
			return "alpha";
		};

		expect(await reported(h, "ask")).toEqual({ action: "accept", content: { project: "alpha" } });
		expect(titles).toHaveLength(1);
		expect(titles[0]).toMatch(
			/^MCP server "octocode" asks for input:\n<<<untrusted-[0-9a-f]{16} \(text from the MCP server/,
		);
		expect(titles[0]).toContain("Which project?\n\nProject id");
	});

	it("answers decline in a session without a user interface", async () => {
		installMcpHost({ elicitation: mcpElicitation({}) });
		const h = await session({}, { hasUI: false });
		h.ctx.ui.input = async () => {
			throw new Error("asked without a user interface");
		};
		expect(await reported(h, "ask")).toEqual({ action: "decline" });
	});
});

describe("reading an elicitation request", () => {
	it("rejects params that are not a request", () => {
		expect(() => readElicitation({ requestedSchema: { type: "object", properties: {} } })).toThrow(/message/);
		expect(() => readElicitation({ message: "x", requestedSchema: { type: "array" } })).toThrow(/requestedSchema/);
	});

	it("reads enum options with their titles and makes server text visible", () => {
		const read = readElicitation(
			form({
				plan: {
					type: "string",
					oneOf: [
						{ const: "free", title: "Free\u0007" },
						{ const: "pro", title: "Pro" },
					],
				},
				tier: { type: "string", enum: ["a", "b"], enumNames: ["Alpha"] },
			}),
		);
		expect(read).toMatchObject({
			fields: [
				{
					name: "plan",
					options: [
						{ value: "free", label: "Free\\u{7}" },
						{ value: "pro", label: "Pro" },
					],
				},
				{
					name: "tier",
					options: [
						{ value: "a", label: "Alpha" },
						{ value: "b", label: "b" },
					],
				},
			],
		});
	});

	it("refuses a form with more fields than are shown together", () => {
		const many = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`f${index}`, { type: "string" }]));
		expect(readElicitation(form(many))).toMatchObject({ refused: expect.stringContaining("more than 8") });
	});
});

describe("checking an elicitation answer", () => {
	const fields = (properties: Record<string, unknown>, required?: string[]) => {
		const read = readElicitation(form(properties, required));
		if ("refused" in read) throw new Error(read.refused);
		return read.fields;
	};

	it("types text as the schema says and leaves empty optional fields out", () => {
		const asked = fields({
			n: { type: "number" },
			i: { type: "integer" },
			b: { type: "boolean" },
			c: { type: "boolean" },
			s: { type: "string" },
			o: { type: "string" },
		});
		expect(checkAnswer(asked, { n: " 2.5 ", i: 7, b: "Yes", c: false, s: "x", o: "  " })).toEqual({
			content: { n: 2.5, i: 7, b: true, c: false, s: "x" },
		});
	});

	it("names the field whose value the schema does not allow", () => {
		const asked = fields(
			{
				i: { type: "integer", minimum: 1, maximum: 5 },
				s: { type: "string", minLength: 2, maxLength: 3 },
				b: { type: "boolean" },
			},
			["s"],
		);
		const problem = (content: Record<string, string | number | boolean>) => checkAnswer(asked, content);
		expect(problem({ i: 1 })).toEqual({ problem: '"s" needs a value' });
		expect(problem({ s: "ab", i: "1.5" })).toEqual({ problem: '"i" must be a whole number' });
		expect(problem({ s: "ab", i: 9 })).toEqual({ problem: '"i" must be at most 5' });
		expect(problem({ s: "ab", i: "x" })).toEqual({ problem: '"i" must be a number' });
		expect(problem({ s: "a" })).toEqual({ problem: '"s" needs at least 2 characters' });
		expect(problem({ s: "abcd" })).toEqual({ problem: '"s" takes at most 3 characters' });
		expect(problem({ s: "ab", b: "maybe" })).toEqual({ problem: '"b" must be yes or no' });
	});
});

describe("elicitation in a server entry", () => {
	it("accepts a boolean and rejects anything else", () => {
		expect(validateMcpServerConfig("docs", { command: "docs", elicitation: false })).toMatchObject({
			elicitation: false,
		});
		expect(validateMcpServerConfig("docs", { command: "docs", elicitation: "off" })).toMatch(
			/elicitation must be a boolean/,
		);
	});
});
