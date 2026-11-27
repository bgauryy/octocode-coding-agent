import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveMcpDefinition } from "../src/add.ts";
import { addMcpWithUi } from "../src/add-ui.ts";
import { literalValuePaths, parseMcpPaste, type McpPasteParse } from "../src/add-parse.ts";
import type { McpServerEntry } from "../src/config.ts";
import { globalMcpConfigPath, projectMcpConfigPath } from "../src/paths.ts";
import type { McpMenu, McpUi } from "../src/ui.ts";
import { mcpHost } from "./mcp-host-fixture.ts";

let root: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-add-paste-"));
	agentDir = path.join(root, "agent");
	cwd = path.join(root, "repo");
	fs.mkdirSync(agentDir);
	fs.mkdirSync(cwd);
	vi.stubEnv("HOME", root);
	vi.stubEnv("OCTOCODE_HOME", agentDir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const stdioJson = '{"mcpServers":{"docs":{"command":"npx","args":["-y","pkg"],"env":{"TOKEN":"${TOKEN}"}}}}';
const httpJson = '{"api":{"url":"https://example.test/mcp","headers":{"Authorization":"Bearer ${TOKEN}"}}}';
const errorsOf = (parsed: McpPasteParse) => {
	if (!("errors" in parsed)) throw new Error("expected errors");
	return parsed.errors;
};

describe("parseMcpPaste", () => {
	it("accepts the mcpServers wrapper, a bare name map, several servers and a code fence", () => {
		expect(parseMcpPaste(stdioJson)).toEqual({
			servers: [
				{
					name: "docs",
					definition: { transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { TOKEN: "${TOKEN}" } },
				},
			],
		});
		expect(parseMcpPaste(httpJson)).toMatchObject({ servers: [{ name: "api", definition: { transport: "http" } }] });
		const many = parseMcpPaste('{"a":{"command":"x"},"b":{"url":"http://localhost:1/mcp"}}');
		expect(many).toMatchObject({ servers: [{ name: "a" }, { name: "b" }] });
		expect(parseMcpPaste(`\`\`\`json\n${httpJson}\n\`\`\``)).toMatchObject({ servers: [{ name: "api" }] });
	});
	it("accepts one bare server object and leaves its name open", () => {
		expect(parseMcpPaste('{"command":"node","args":["s.js"],"env":{}}')).toEqual({
			servers: [{ name: undefined, definition: { transport: "stdio", command: "node", args: ["s.js"], env: {} } }],
		});
		expect(parseMcpPaste('{"type":"http","url":"https://example.test/mcp"}')).toMatchObject({
			servers: [{ name: undefined, definition: { transport: "http" } }],
		});
	});
	it.each([
		['{"mcpServers":{"docs":{"command":"x","args":"nope"}}}', "mcpServers.docs.args: must be an array of strings"],
		['{"mcpServers":{"docs":{"command":"x","args":["a",2]}}}', "mcpServers.docs.args: must be an array of strings"],
		['{"mcpServers":{"docs":{"command":"x","env":{"TOKEN":5}}}}', "mcpServers.docs.env.TOKEN: must be a string"],
		['{"mcpServers":{"docs":{"command":"x","env":[]}}}', "mcpServers.docs.env: must be an object"],
		['{"mcpServers":{"api":{"url":"ftp://example.test"}}}', "mcpServers.api.url: must be an http:// or https:// URL"],
		['{"mcpServers":{"api":{"url":"https://e.test","headers":{"A":1}}}}', "mcpServers.api.headers.A: must be a string"],
		['{"mcpServers":{"x":{"command":"a","url":"https://e.test"}}}', 'mcpServers.x: set either "command"'],
		['{"mcpServers":{"x":{"args":[]}}}', 'mcpServers.x: must set "command"'],
		['{"mcpServers":{"x":{"command":"a","cwd":"."}}}', "mcpServers.x.cwd: unsupported field"],
		['{"mcpServers":{"x":{"type":"sse","url":"https://e.test"}}}', "mcpServers.x.type: legacy SSE"],
		['{"mcpServers":{"bad name":{"command":"a"}}}', 'mcpServers."bad name": name must be'],
		['{"mcpServers":{"a__b":{"command":"a"}}}', "mcpServers.a__b: name is not allowed"],
		['{"mcpServers":{"my-server":{"command":"a"},"my_server":{"command":"b"}}}', "collides with"],
		['{"mcpServers":{}}', "mcpServers: define at least one server"],
		['{"mcpServers":[]}', "mcpServers: must be an object"],
		['{"x":{"command":""}}', "x.command: must be a non-blank string"],
		['{"x":"nope"}', "x: must be an object"],
		["[]", "JSON: must be an object"],
	])("names the path and the rule: %s", (text, expected) => {
		expect(errorsOf(parseMcpPaste(text)).join("\n")).toContain(expected);
	});
	it("never echoes pasted values in errors, including malformed JSON", () => {
		const secret = "sk-private-marker";
		const cases = [
			`{"mcpServers":{"a":{"command":"x","env":{"T":"${secret}"}}} trailing`,
			`{"mcpServers":{"a":{"url":"${secret}","headers":{"Authorization":"${secret}"}}}}`,
			`{"mcpServers":{"a":{"command":"x","args":"${secret}","env":{"T":"${secret}","U":1}}}}`,
			`{"mcpServers":{"a":{"type":"${secret}","command":"x"}}}`,
			`{"mcpServers":{"a":{"command":"x","k":"${secret}"}}}`,
		];
		for (const text of cases) expect(errorsOf(parseMcpPaste(text)).join("\n")).not.toContain(secret);
		expect(errorsOf(parseMcpPaste(cases[0] ?? ""))[0]).toMatch(/^JSON: not valid JSON/);
	});
	it("lists literal env and header values by path, not value, and skips ${VAR} references", () => {
		const parsed = parseMcpPaste(
			'{"a":{"command":"x","env":{"T":"literal-marker","U":"${U}"}},"b":{"url":"https://e.test","headers":{"Authorization":"Bearer literal-marker"}}}',
		);
		if ("errors" in parsed) throw new Error("unexpected");
		const paths = literalValuePaths(parsed.servers.map((server) => ({ ...server, name: server.name as string })));
		expect(paths).toEqual(["mcpServers.a.env.T", "mcpServers.b.headers.Authorization"]);
	});
});

function ui(choices: (string | undefined)[], inputs: (string | undefined)[]) {
	const menus: McpMenu[] = [];
	const input = vi.fn(async (_title: string, _value: string, _hint: string) => inputs.shift());
	const port: McpUi = {
		menu: async (build) => {
			menus.push(build());
			return choices.shift();
		},
		input,
		status: () => {},
		redirectUrl: async () => undefined,
	};
	return { port, menus, input };
}
async function started(servers: McpServerEntry[] = [], trusted = false) {
	const host = mcpHost({ cwd, servers, presets: [] });
	await host.start();
	host.state.projectTrusted = trusted;
	return host;
}
const registryEntry = (name: string): McpServerEntry => ({
	name,
	source: "test",
	scope: "feature",
	config: { command: "node", args: [], enabled: false },
});

describe("paste-first Add MCP", () => {
	it("opens with the titled prompt, both examples and the docs path", async () => {
		const host = await started();
		const { port, input } = ui([], [undefined]);
		await addMcpWithUi(host.state, port, { docsPath: "/docs/mcp.md" });
		const [title, , hint] = input.mock.calls[0] ?? [];
		expect(title).toBe("Add MCP — paste a valid JSON MCP definition");
		expect(hint).toContain('"command"');
		expect(hint).toContain('"url"');
		expect(hint).toContain("/docs/mcp.md");
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
		await host.close();
	});
	it.each([
		["mcpWrapper stdio", stdioJson, "docs", []],
		["name map http", httpJson, "api", []],
		["bare stdio", '{"command":"node","args":["s.js"]}', "asked", ["asked"]],
		["bare http", '{"url":"https://example.test/mcp"}', "asked", ["asked"]],
	])("saves %s to the chosen scope, off and unassigned", async (_label, text, name, extraInputs) => {
		const host = await started();
		const { port, menus } = ui(["global", "save", "done"], [text, ...extraInputs]);
		await addMcpWithUi(host.state, port);
		const saved = read(globalMcpConfigPath(agentDir)).mcpServers[name];
		expect(saved).toMatchObject({ enabled: false, defaultActive: false });
		expect(menus[0]?.title).toBe("Add MCP — save to");
		expect(menus.at(-1)?.facts).toEqual([{ label: name, value: expect.stringContaining("saved") }]);
		expect(fs.existsSync(projectMcpConfigPath(cwd))).toBe(false);
		await host.close();
	});
	it("re-asks an invalid name for a bare server", async () => {
		const host = await started();
		const { port, input } = ui(["global", "save", "done"], ['{"command":"node"}', "bad name", "good"]);
		await addMcpWithUi(host.state, port);
		expect(input.mock.calls[2]?.[2]).toContain("name");
		expect(Object.keys(read(globalMcpConfigPath(agentDir)).mcpServers)).toEqual(["good"]);
		await host.close();
	});
	it("saves every server of one paste to the workspace and reports each", async () => {
		const host = await started([], true);
		const text = '{"mcpServers":{"one":{"command":"a"},"two":{"url":"https://example.test/mcp"}}}';
		const { port, menus } = ui(["workspace", "save", "done"], [text]);
		await addMcpWithUi(host.state, port);
		expect(menus[0]?.items.map((item) => item.value)).toEqual(["global", "workspace"]);
		expect(Object.keys(read(projectMcpConfigPath(cwd)).mcpServers)).toEqual(["one", "two"]);
		expect(menus.at(-1)?.facts?.map((row) => row.label)).toEqual(["one", "two"]);
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
		await host.close();
	});
	it("does not offer the workspace when untrusted and refuses it if chosen anyway", async () => {
		const host = await started();
		const { port, menus } = ui(["workspace", "save", "done"], ['{"a":{"command":"x"}}']);
		await addMcpWithUi(host.state, port);
		expect(menus[0]?.items.map((item) => item.value)).toEqual(["global"]);
		expect(menus.at(-1)?.facts?.[0]?.value).toMatch(/Trust the workspace/);
		expect(fs.existsSync(projectMcpConfigPath(cwd))).toBe(false);
		await host.close();
	});
	it("keeps the pasted text after bad JSON and writes nothing when cancelled", async () => {
		const host = await started();
		const bad = '{"mcpServers":{"docs":{"command":"x","args":"nope"}}}';
		const { port, menus, input } = ui(["edit"], [bad, undefined]);
		await addMcpWithUi(host.state, port);
		expect(menus[0]?.error).toContain("mcpServers.docs.args: must be an array of strings");
		expect(input.mock.calls[1]?.[1]).toBe(bad);
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
		await host.close();
	});
	it("warns about literal credentials without echoing them, and lets the user continue or edit", async () => {
		const host = await started();
		const text = '{"a":{"command":"x","env":{"TOKEN":"sk-private-marker"}}}';
		const editing = ui(["edit"], [text, undefined]);
		await addMcpWithUi(host.state, editing.port);
		expect(editing.menus[0]?.error).toContain("mcpServers.a.env.TOKEN");
		expect(JSON.stringify(editing.menus)).not.toContain("sk-private-marker");
		expect(editing.input.mock.calls[1]?.[1]).toBe(text);
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
		const continuing = ui(["save", "global", "save", "done"], [text]);
		await addMcpWithUi(host.state, continuing.port);
		expect(read(globalMcpConfigPath(agentDir)).mcpServers.a.env.TOKEN).toBe("sk-private-marker");
		expect(JSON.stringify(continuing.menus)).not.toContain("sk-private-marker");
		await host.close();
	});
	it("offers the field form from the prompt and from an error", async () => {
		const host = await started();
		const fromPrompt = ui(["field", undefined], [""]);
		await addMcpWithUi(host.state, fromPrompt.port);
		expect(fromPrompt.menus[1]?.title).toBe("Add MCP — save to");
		const fromError = ui(["field", undefined], ["not json"]);
		await addMcpWithUi(host.state, fromError.port);
		expect(fromError.menus[1]?.title).toBe("Add MCP — save to");
		await host.close();
	});
	it("writes nothing when cancelled at the prompt, at the scope menu or at the warning", async () => {
		const host = await started();
		await addMcpWithUi(host.state, ui([], [undefined]).port);
		await addMcpWithUi(host.state, ui([undefined], ['{"a":{"command":"x"}}']).port);
		await addMcpWithUi(host.state, ui([undefined], ['{"a":{"command":"x","env":{"T":"lit"}}}']).port);
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
		await host.close();
	});
});

describe("collisions for pasted servers (B209 check)", () => {
	it("refuses names in the target file or the live registry, writing nothing, even with a free name beside them", async () => {
		saveMcpDefinition(
			{ name: "taken", scope: "global", transport: "stdio", command: "x" },
			{ agentDir, cwd, projectTrusted: true },
		);
		const before = fs.readFileSync(globalMcpConfigPath(agentDir), "utf8");
		const host = await started([registryEntry("live-one")]);
		for (const clash of ["taken", "live_one", "live-one"]) {
			const text = `{"mcpServers":{"free":{"command":"a"},"${clash}":{"command":"b"}}}`;
			const { port, menus } = ui(["global", undefined], [text]);
			await addMcpWithUi(host.state, port);
			expect(menus.at(-1)?.error).toContain("already exists");
			expect(fs.readFileSync(globalMcpConfigPath(agentDir), "utf8")).toBe(before);
		}
		await host.close();
	});
	it("refuses a registry name that is not in any file (a change the files do not show yet)", async () => {
		const host = await started([registryEntry("registered")]);
		const { port, menus } = ui(["global", undefined], ['{"registered":{"command":"a"}}']);
		await addMcpWithUi(host.state, port);
		expect(menus.at(-1)?.error).toContain("registered: an MCP server with this name already exists");
		expect(fs.existsSync(globalMcpConfigPath(agentDir))).toBe(false);
		await host.close();
	});
});
